import { extname } from 'node:path'
import { open } from 'node:fs/promises'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeSession } from './claude-structured-session-state'
import { readClaudeFrameString } from './claude-structured-init-proof'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
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

/** Text of a top-level user frame, or null when it is a tool-result turn (or
 *  carries nothing). `content` may be a plain string - a shape
 *  `readClaudeMessageEnvelope` already tolerates. An image-only echo has no text
 *  and correctly yields ''. */
function claudeUserFrameText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content) || content.length === 0) {
    return null
  }
  const parts = content.map((part) => claudeRecord(part))
  if (parts.some((part) => part?.type === 'tool_result')) {
    return null
  }
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
}

/**
 * The frame that carries the user's own message back.
 *
 * `type: 'user'` with a null `parent_tool_use_id` is not enough on its own:
 * Claude publishes tool results and harness-injected turns (interruption
 * notices, system reminders, local-command output) in the same shape. Adopting
 * one of those leaves the real replay to land under an identity nothing claims,
 * so the user's message renders twice - and an injected turn is worse than a
 * tool result, because it DOES build a body and upserts over the user's own
 * bubble.
 *
 * `--replay-user-messages` stamps `isReplay` on the genuine echo, so trust that
 * when it is there. The shape test is the fallback for a CLI that omits it:
 * without one, a send that is never acknowledged times out into a false
 * "delivery unconfirmed", and retrying it sends the message to Claude twice.
 *
 * Measured against the real CLI: a queued send's replay is published at the
 * first tool boundary after it is queued, 2-3 ms AFTER that boundary's tool
 * result. So rejecting tool results costs no time - whenever there was a frame
 * to adopt, the right one follows immediately.
 */
function isClaudeUserMessageReplay(message: Record<string, unknown>): boolean {
  if (message.type !== 'user' || message.parent_tool_use_id !== null) {
    return false
  }
  if (message.isReplay === true) {
    return true
  }
  const text = claudeUserFrameText(claudeRecord(message.message)?.content)
  return text !== null && !isKnownHarnessInjectedUserTurnText(text)
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
