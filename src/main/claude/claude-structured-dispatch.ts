import { extname } from 'node:path'
import { open } from 'node:fs/promises'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeSession } from './claude-structured-session-state'
import { readClaudeFrameString } from './claude-structured-init-proof'
import { claudeRecord } from './claude-structured-item-translation'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_COUNT = 20
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

type ImageBudget = {
  count: number
  localBytes: number
}

async function readClaudeImage(path: string): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) {
      throw new Error('Claude image must be a file')
    }
    const buffer = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
    }
    if (bytesRead === 0 || bytesRead > MAX_IMAGE_BYTES) {
      throw new Error(
        `Claude image must be a non-empty file no larger than ${MAX_IMAGE_BYTES} bytes`
      )
    }
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

/**
 * The frame that carries the user's own message back.
 *
 * Claude publishes a top-level `user` turn for tool results too, with the same
 * null `parent_tool_use_id`, so "any user turn" adopts whichever arrives first.
 * A send issued mid-turn is dispatched while tools are running, and adopting a
 * tool-result uuid leaves the real replay to land under an identity nothing
 * claims — the user's message then renders twice, once from the submission row
 * and once from the replay.
 *
 * Measured against the real CLI: a queued send's replay is published at the first
 * tool boundary after it is queued, 2-3 ms AFTER that boundary's tool result. So
 * rejecting tool results costs no time — whenever there was a frame to adopt, the
 * right one follows immediately.
 *
 * Reject on the tool-result shape rather than on "the journal translator would
 * build a body from this": `claudeMessageBody` models only text and URL images,
 * so an image-only send (dispatch base64-encodes local paths) has no modeled
 * block and would be refused its own replay, timing out into a false
 * "delivery unconfirmed" that invites a genuine duplicate send on retry.
 */
function isClaudeUserMessageReplay(message: Record<string, unknown>): boolean {
  if (message.type !== 'user' || message.parent_tool_use_id !== null) {
    return false
  }
  const content = claudeRecord(message.message)?.content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    !content.some((part) => claudeRecord(part)?.type === 'tool_result')
  )
}

export function resolveClaudeReplayWaiter(
  session: ClaudeSession,
  message: Record<string, unknown>
): void {
  const isUserReplay = isClaudeUserMessageReplay(message)
  const isCompletedCommand = message.type === 'result'
  if (
    (!isUserReplay && !isCompletedCommand) ||
    readClaudeFrameString(message, 'session_id') !== session.providerSessionId
  ) {
    return
  }
  const uuid = readClaudeFrameString(message, 'uuid')
  const current = session.dispatchWaiters[0]
  if (isCompletedCommand && !current?.acceptsResult) {
    return
  }
  const waiter = uuid ? session.dispatchWaiters.shift() : undefined
  if (waiter && uuid) {
    clearTimeout(waiter.timer)
    waiter.resolve(uuid)
  }
}

async function imageContent(
  block: Extract<NativeChatBlock, { type: 'image-ref' }>,
  budget: ImageBudget
): Promise<unknown> {
  budget.count += 1
  if (budget.count > MAX_IMAGE_COUNT) {
    throw new Error(`Claude messages support at most ${MAX_IMAGE_COUNT} images`)
  }
  if (block.url) {
    return { type: 'image', source: { type: 'url', url: block.url } }
  }
  if (!block.path) {
    throw new Error('image reference has neither a path nor a URL')
  }
  const data = await readClaudeImage(block.path)
  budget.localBytes += data.byteLength
  if (budget.localBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(`Claude images must total no more than ${MAX_TOTAL_IMAGE_BYTES} bytes`)
  }
  const mediaType = IMAGE_MIME_BY_EXTENSION[extname(block.path).toLowerCase()]
  if (!mediaType) {
    throw new Error(`Claude does not support the image type ${extname(block.path)}`)
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: data.toString('base64')
    }
  }
}

async function messageContent(body: AgentJournalMessageItem): Promise<unknown[]> {
  if (body.role !== 'user') {
    throw new Error('Claude dispatch accepts only user messages')
  }
  const content: unknown[] = []
  const imageBudget: ImageBudget = { count: 0, localBytes: 0 }
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref') {
      content.push(await imageContent(block, imageBudget))
    }
  }
  if (content.length === 0) {
    throw new Error('Claude dispatch requires text or an image')
  }
  return content
}

function waitForReplay(
  session: ClaudeSession,
  timeoutMs: number,
  acceptsResult: boolean
): Promise<string | null> {
  return new Promise((resolve) => {
    const waiter = {
      acceptsResult,
      resolve,
      timer: setTimeout(() => {
        const index = session.dispatchWaiters.indexOf(waiter)
        if (index !== -1) {
          session.dispatchWaiters.splice(index, 1)
        }
        resolve(null)
      }, timeoutMs)
    }
    waiter.timer.unref?.()
    session.dispatchWaiters.push(waiter)
  })
}

export async function dispatchClaudeTurn(
  session: ClaudeSession,
  input: { clientMessageId: string; body: AgentJournalMessageItem },
  timeoutMs: number
): Promise<AgentSessionDispatchOutcome> {
  let content: unknown[]
  try {
    content = await messageContent(input.body)
  } catch (error) {
    return { state: 'rejected', reason: (error as Error).message }
  }
  const acceptsResult = input.body.blocks.some(
    (block) => block.type === 'text' && block.text.trimStart().startsWith('/')
  )
  const replayed = waitForReplay(session, timeoutMs, acceptsResult)
  try {
    await session.connection.send({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.providerSessionId
    })
  } catch (error) {
    const waiter = session.dispatchWaiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    return { state: 'unknown', reason: (error as Error).message }
  }
  const uuid = await replayed
  return uuid
    ? {
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
      }
    : { state: 'unknown', reason: 'claude accepted a message but did not replay its uuid in time' }
}
