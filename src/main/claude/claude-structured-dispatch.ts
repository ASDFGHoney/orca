import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { open } from 'node:fs/promises'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeDispatchWaiter, ClaudeSession } from './claude-structured-session-state'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
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

/** Leading text of a top-level user frame, for harness classification. The CLI
 *  serializes an injected breadcrumb's content as a plain string and a typed
 *  echo's as a block array, so both shapes have to be read. */
function claudeUserFrameText(message: Record<string, unknown>): string {
  const content = claudeRecord(message.message)?.content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => {
      const text = claudeRecord(part)?.text
      return typeof text === 'string' ? text : ''
    })
    .join('\n')
}

/**
 * The frame that carries the user's own message back.
 *
 * `type: 'user'` with a null `parent_tool_use_id` is not enough: Claude
 * publishes tool results and harness-injected turns in the same shape. Adopting
 * one leaves the real replay under an identity nothing claims, so the user's
 * message renders twice - and an injected turn is worse than a tool result,
 * because it can build a body and upsert over the user's own bubble.
 *
 * `isReplay` is necessary but NOT sufficient. Claude stamps it on its own
 * injected breadcrumbs too: 2.1.237 enqueues the model-switch notice as
 * `{type:'user', parent_tool_use_id:null, isReplay:true}` whose content is the
 * string `<local-command-stdout>Set model to ...`. Orca triggers that path
 * itself from the model picker (`setClaudeStructuredOption` sends `set_model`,
 * and reconnect replays it). The CLI's own RemoteSessionManager cannot use the
 * marker alone either - it filters the same frames by content prefix, logging
 * "Dropped own set_model breadcrumb echo".
 *
 * So: require the marker, then reject the harness shapes. The residual is a
 * genuine echo whose own text opens with a harness tag (a user pasting a
 * transcript excerpt), which is rarer than a model switch and fails the safe
 * way - `unknown`, not a corrupted bubble.
 */
function isClaudeUserMessageReplay(message: Record<string, unknown>): boolean {
  if (message.type !== 'user' || message.parent_tool_use_id !== null || message.isReplay !== true) {
    return false
  }
  return !isKnownHarnessInjectedUserTurnText(claudeUserFrameText(message))
}

function settleWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter, uuid: string): void {
  dropWaiter(session, waiter)
  clearTimeout(waiter.timer)
  waiter.settledUuid = uuid
  waiter.resolve(uuid)
}

export function resolveClaudeReplayWaiter(
  session: ClaudeSession,
  message: Record<string, unknown>
): void {
  if (readClaudeFrameString(message, 'session_id') !== session.providerSessionId) {
    return
  }
  const uuid = readClaudeFrameString(message, 'uuid')
  if (!uuid) {
    return
  }
  // Exact correlation: the CLI echoes the uuid we stamped on the outgoing frame,
  // so this replay belongs to that dispatch whatever its queue position - which
  // is what keeps a late replay from settling somebody else's send.
  const owner = session.dispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (owner) {
    settleWaiter(session, owner, uuid)
    return
  }
  // A replay for a dispatch that already gave up belongs to nobody. Dropping it
  // here is what keeps the compat path below from handing it to the head, which
  // would upsert the dead send's text over a live one's bubble.
  if (session.retiredSentUuids?.includes(uuid)) {
    return
  }
  // Compat path for a CLI that mints its own uuid instead of echoing ours. The
  // frame then carries no correlation at all, so the head is the only candidate
  // and the shape gates have to carry the weight.
  const isCompletedCommand = message.type === 'result'
  if (!isClaudeUserMessageReplay(message) && !isCompletedCommand) {
    return
  }
  const head = session.dispatchWaiters[0]
  if (!head || (isCompletedCommand && !head.acceptsResult)) {
    return
  }
  settleWaiter(session, head, uuid)
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

/** Enough to cover the replays still in flight for sends that gave up; the list
 *  only grows when a dispatch leaves without its echo. */
const RETIRED_UUID_MEMORY = 64

function dropWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
}

/** Remember a dispatch that left without its echo, so the echo cannot later be
 *  mistaken for somebody else's on the compat path. */
function retireWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  dropWaiter(session, waiter)
  const retired = session.retiredSentUuids ?? []
  retired.push(waiter.sentUuid)
  session.retiredSentUuids = retired.slice(-RETIRED_UUID_MEMORY)
}

/** Arms a waiter and hands it back, so a failure can retire ITS OWN waiter — the
 *  queue is positional, and shifting the head resolves whichever send happens to
 *  be first instead. */
function waitForReplay(
  session: ClaudeSession,
  timeoutMs: number,
  acceptsResult: boolean,
  sentUuid: string
): { waiter: ClaudeDispatchWaiter; replayed: Promise<string | null> } {
  let waiter!: ClaudeDispatchWaiter
  const replayed = new Promise<string | null>((resolve) => {
    waiter = {
      acceptsResult,
      sentUuid,
      resolve,
      timer: setTimeout(() => {
        retireWaiter(session, waiter)
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
  // Stamped so the echo can be matched to THIS dispatch: the CLI round-trips a
  // client-supplied uuid verbatim (measured), and it also dedupes on it, so a
  // resend of the same frame cannot land twice.
  const sentUuid = randomUUID()
  const { waiter, replayed } = waitForReplay(session, timeoutMs, acceptsResult, sentUuid)
  try {
    await session.connection.send({
      type: 'user',
      uuid: sentUuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.providerSessionId
    })
  } catch (error) {
    // A write can reach Claude and still reject on the flush that follows, so the
    // replay may already have claimed this waiter. Reporting `unknown` then
    // strands an identity nothing else can adopt, and the echo duplicates.
    if (waiter.settledUuid) {
      const settled = await replayed
      if (settled) {
        return {
          state: 'accepted',
          providerIdentity: {
            provider: 'claude',
            sessionId: session.providerSessionId,
            uuid: settled
          }
        }
      }
    }
    retireWaiter(session, waiter)
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
