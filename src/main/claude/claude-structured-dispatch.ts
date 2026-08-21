import { extname } from 'node:path'
import { open } from 'node:fs/promises'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeDispatchWaiter, ClaudeSession } from './claude-structured-session-state'
import { readClaudeFrameString } from './claude-structured-init-proof'

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
 * `type: 'user'` with a null `parent_tool_use_id` is not enough on its own:
 * Claude publishes tool results and harness-injected turns (interruption
 * notices, system reminders, local-command output) in the same shape. Adopting
 * one leaves the real replay to land under an identity nothing claims, so the
 * user's message renders twice - and an injected turn is worse than a tool
 * result, because it DOES build a body and upserts over the user's own bubble.
 *
 * `CLAUDE_STRUCTURED_BASE_ARGS` always passes `--replay-user-messages`, and the
 * CLI stamps `isReplay` on every echo it publishes in reply - measured for text,
 * image-only and text+image sends. So the marker is the whole test: no content
 * sniffing, and nothing here depends on the injected-turn list that
 * prompt-derived UI maintains for its own reasons.
 *
 * A slash command may get no user echo at all; `acceptsResult` settles those on
 * the command's result receipt instead.
 *
 * Measured against the real CLI: a queued send's replay is published at the
 * first tool boundary after it is queued, 2-3 ms AFTER that boundary's tool
 * result. So rejecting tool results costs no time - whenever there was a frame
 * to adopt, the right one follows immediately.
 */
function isClaudeUserMessageReplay(message: Record<string, unknown>): boolean {
  return message.type === 'user' && message.parent_tool_use_id === null && message.isReplay === true
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

function dropWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
}

/** Arms a waiter and hands it back, so a failure can retire ITS OWN waiter — the
 *  queue is positional, and shifting the head resolves whichever send happens to
 *  be first instead. */
function waitForReplay(
  session: ClaudeSession,
  timeoutMs: number,
  acceptsResult: boolean
): { waiter: ClaudeDispatchWaiter; replayed: Promise<string | null> } {
  let waiter!: ClaudeDispatchWaiter
  const replayed = new Promise<string | null>((resolve) => {
    waiter = {
      acceptsResult,
      resolve,
      timer: setTimeout(() => {
        dropWaiter(session, waiter)
        resolve(null)
      }, timeoutMs)
    }
    waiter.timer.unref?.()
    session.dispatchWaiters.push(waiter)
  })
  return { waiter, replayed }
}

// A command token: `/model`, `/clear`, `/project:foo`. Not `/Users/me/foo.ts`
// (slash) and not `/README.md` (dot).
const SLASH_COMMAND_TOKEN = /^\/[a-z0-9][\w:-]*$/i

/**
 * A slash command, not a message that merely opens with a path.
 *
 * `acceptsResult` lets a send settle on a bare `result` frame, which carries no
 * correlation to the dispatch that is waiting - so a false positive lets an
 * unrelated turn's result claim the send's identity, and the real echo then
 * appends a second row. This is stricter than `classifyNativeChatSend`, which
 * treats any `/`-leading token as command-ish: over-classifying is safe there
 * (it only suppresses an echo) and unsafe here.
 *
 * No trimming, and MEASURED rather than inherited from the TUI rule: `  /clear`
 * came back from `claude -p --input-format stream-json` as a stamped replay, so
 * this lane also reads an indented token as prose.
 *
 * Residual, unfixable by shape: `/tmp what is in here?` matches, because `/tmp`
 * is indistinguishable from `/clear`. The agent's command catalog cannot close
 * it either - `getVerifiedNativeChatCommands('claude')` is a curated `/` menu
 * (clear, compact, init, review, help) and omits real built-ins like `/model`
 * and `/permissions`, both measured as answering with a bare `result` and no
 * echo; gating on it would strand those sends instead. Measured mitigation: a
 * path-leading message DOES get a stamped replay, so it only mis-settles if an
 * unrelated `result` beats that replay.
 */
function isSlashCommandText(text: string): boolean {
  return SLASH_COMMAND_TOKEN.test(text.split(/\s/, 1)[0] ?? '')
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
    (block) => block.type === 'text' && isSlashCommandText(block.text)
  )
  const { waiter, replayed } = waitForReplay(session, timeoutMs, acceptsResult)
  try {
    await session.connection.send({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.providerSessionId
    })
  } catch (error) {
    dropWaiter(session, waiter)
    clearTimeout(waiter.timer)
    waiter.resolve(null)
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
