import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { dispatchClaudeTurn, resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import type { ClaudeSession } from './claude-structured-session-state'

function sessionFor(send = vi.fn().mockResolvedValue(undefined)): ClaudeSession {
  return {
    connection: { send } as unknown as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    leafUuid: null,
    fence: 1,
    prompts: {} as ClaudeSession['prompts'],
    dispatchWaiters: [],
    options: new Map(),
    reportedOptions: {},
    events: undefined,
    translator: null
  }
}

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

/** Claude's `--replay-user-messages` echo of a prompt Orca dispatched. */
function userReplayFrame(uuid: string, text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    session_id: 'provider-session',
    parent_tool_use_id: null,
    uuid,
    isReplay: true
  }
}

describe('Claude structured dispatch image limits', () => {
  it('accepts a slash command from its result receipt when Claude omits the user replay', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: '/permissions' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'result',
      subtype: 'success',
      session_id: 'provider-session',
      uuid: 'command-result-uuid'
    })

    await expect(dispatched).resolves.toEqual({
      state: 'accepted',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'command-result-uuid'
      }
    })
  })

  it('does not mistake a normal turn result for its missing user replay', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'hello' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'result',
      session_id: 'provider-session',
      uuid: 'unrelated-result-uuid'
    })
    expect(session.dispatchWaiters).toHaveLength(1)
    resolveClaudeReplayWaiter(session, userReplayFrame('user-replay-uuid', 'hello'))

    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'user-replay-uuid' }
    })
  })

  // Both frames captured verbatim from `claude -p --input-format stream-json
  // --output-format stream-json --replay-user-messages`: the replay of the sent
  // prompt and the tool-result turn that follows it share `type: 'user'` and a
  // null `parent_tool_use_id`.
  it('does not adopt a tool-result turn as the user replay', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'queued' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'toolu_01TY2ETgHfpYVuq3ETuGYfDV',
            type: 'tool_result',
            content: 'probe-two',
            is_error: false
          }
        ]
      },
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'tool-result-uuid',
      tool_use_result: { stdout: 'probe-two', stderr: '', interrupted: false }
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(session, userReplayFrame('user-replay-uuid', 'queued'))

    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'user-replay-uuid' }
    })
  })

  // An injected turn is the worse half of this class: unlike a tool result it
  // DOES build a journal body, so adopting its uuid upserts harness text over the
  // user's own bubble AND leaves the real replay to append as a second row.
  it('does not adopt a harness-injected user turn as the user replay', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'queued' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'injected-uuid'
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(session, userReplayFrame('user-replay-uuid', 'queued'))

    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'user-replay-uuid' }
    })
  })

  // Once this CLI is seen stamping the marker, the injected-turn allowlist must
  // stop being load-bearing: an unrecognized injected shape would otherwise still
  // steal the identity.
  it('stops trusting frame shape once the CLI is seen stamping isReplay', async () => {
    const session = sessionFor()
    const first = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'one' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    resolveClaudeReplayWaiter(session, userReplayFrame('replay-one', 'one'))
    await expect(first).resolves.toMatchObject({ state: 'accepted' })

    const second = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-2', body: userMessage([{ type: 'text', text: 'two' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    // An injected shape nobody has enumerated yet, so the allowlist would pass it.
    resolveClaudeReplayWaiter(session, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<some-new-notice>hi' }] },
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'unknown-injected-uuid'
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(session, userReplayFrame('replay-two', 'two'))
    await expect(second).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'replay-two' }
    })
  })

  // `readClaudeMessageEnvelope` already tolerates string content, so refusing it
  // here would be a new way for a send to never be acknowledged.
  it('accepts a replay whose content is a plain string', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'hello' }]) },
      100
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'string-replay-uuid'
    })

    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'string-replay-uuid' }
    })
  })

  // Dispatch base64-encodes a local image path, and `claudeMessageBody` models
  // only text and URL images - so gating the waiter on "the translator would
  // build a body" refuses an image-only send its own replay, times out, and
  // reports a delivered message as unconfirmed (retry then sends it twice).
  it('accepts the replay of a send that carries only a local image', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-replay-'))
    try {
      const path = join(directory, 'shot.png')
      await writeFile(path, Buffer.alloc(64))
      const session = sessionFor()
      const dispatched = dispatchClaudeTurn(
        session,
        { clientMessageId: 'client-1', body: userMessage([{ type: 'image-ref', path }]) },
        100
      )
      await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

      resolveClaudeReplayWaiter(session, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
          ]
        },
        parent_tool_use_id: null,
        session_id: 'provider-session',
        uuid: 'image-replay-uuid',
        isReplay: true
      })

      await expect(dispatched).resolves.toMatchObject({
        state: 'accepted',
        providerIdentity: { uuid: 'image-replay-uuid' }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects more than twenty URL images before sending', async () => {
    const session = sessionFor()
    const body = userMessage(
      Array.from({ length: 21 }, (_, index) => ({
        type: 'image-ref' as const,
        url: `https://example.test/${index}.png`
      }))
    )

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
    ).resolves.toEqual({ state: 'rejected', reason: 'Claude messages support at most 20 images' })
    expect(session.connection.send).not.toHaveBeenCalled()
  })

  it('rejects local images whose aggregate size exceeds twenty MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-images-'))
    try {
      const paths = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const path = join(directory, `${index}.png`)
          await writeFile(path, Buffer.alloc(5 * 1024 * 1024))
          return path
        })
      )
      const session = sessionFor()
      const body = userMessage(paths.map((path) => ({ type: 'image-ref' as const, path })))

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude images must total no more than ${20 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a local image by actual bytes read beyond the per-image cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'oversized.png')
      await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1))
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body }, 1)
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude image must be a non-empty file no larger than ${5 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
