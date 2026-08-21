import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { dispatchClaudeTurn, resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import type { ClaudeSession } from './claude-structured-session-state'

// vi.waitFor's first successful poll lands ~50ms after the waiter is armed, so a
// 100ms ack budget leaves almost none for the frame under parallel load.
const ACK_BUDGET_MS = 5_000

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
      ACK_BUDGET_MS
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
      ACK_BUDGET_MS
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
      ACK_BUDGET_MS
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
      ACK_BUDGET_MS
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

  // NOT red against the merge base - the old predicate accepts this frame too.
  // It pins that the gate never sniffs content: an image-only echo carries no
  // text and builds no journal body, so any body-model gate would refuse this
  // send its own replay and report a delivered message as unconfirmed.
  it('accepts the replay of a send that carries only a local image', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-replay-'))
    try {
      const path = join(directory, 'shot.png')
      await writeFile(path, Buffer.alloc(64))
      const session = sessionFor()
      const dispatched = dispatchClaudeTurn(
        session,
        { clientMessageId: 'client-1', body: userMessage([{ type: 'image-ref', path }]) },
        ACK_BUDGET_MS
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

  // `acceptsResult` settles a send on a bare `result` frame, which carries no
  // correlation to the waiting dispatch - so a message that merely opens with a
  // path must not opt into it, or an unrelated turn's result claims its identity.
  it('does not let a path-leading message settle on an unrelated result frame', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: '/Users/me/repo/src/foo.ts - explain this' }])
      },
      ACK_BUDGET_MS
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'result',
      subtype: 'success',
      session_id: 'provider-session',
      uuid: 'unrelated-turn-result'
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(
      session,
      userReplayFrame('real-replay', '/Users/me/repo/src/foo.ts - explain this')
    )
    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'real-replay' }
    })
  })

  it.each([
    ['/README.md - what does this do?', 'a bare filename'],
    ['  /clear', 'an indented command, which the TUI reads as prose']
  ])('keeps %s off the result path (%s)', async (text) => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text }]) },
      ACK_BUDGET_MS
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'result',
      subtype: 'success',
      session_id: 'provider-session',
      uuid: 'unrelated-turn-result'
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(session, userReplayFrame('real-replay', text))
    await expect(dispatched).resolves.toMatchObject({
      providerIdentity: { uuid: 'real-replay' }
    })
  })

  // Captured from claude 2.1.237: the model-switch breadcrumb is enqueued as
  // `{type:'user', parent_tool_use_id:null, isReplay:true}` with STRING content.
  // Orca triggers it itself from the model picker, and the CLI's own
  // RemoteSessionManager filters the same frames by content prefix.
  it('does not adopt a model-switch breadcrumb even though it is stamped', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'queued' }]) },
      ACK_BUDGET_MS
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stdout>Set model to Sonnet</local-command-stdout>'
      },
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'breadcrumb-uuid',
      isReplay: true
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(session, userReplayFrame('user-replay-uuid', 'queued'))
    await expect(dispatched).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'user-replay-uuid' }
    })
  })

  // The waiter queue is positional, so shifting the head on a send failure
  // resolves whichever dispatch happens to be first - reporting a delivered
  // message as unconfirmed while the send that actually failed keeps waiting.
  it('retires its own waiter when the send fails, not the one at the head', async () => {
    const session = sessionFor()
    const first = dispatchClaudeTurn(
      session,
      { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'one' }]) },
      ACK_BUDGET_MS
    )
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const firstWaiter = session.dispatchWaiters[0]

    session.connection.send = vi.fn().mockRejectedValue(new Error('broken pipe'))
    await expect(
      dispatchClaudeTurn(
        session,
        { clientMessageId: 'client-2', body: userMessage([{ type: 'text', text: 'two' }]) },
        ACK_BUDGET_MS
      )
    ).resolves.toEqual({ state: 'unknown', reason: 'broken pipe' })

    expect(session.dispatchWaiters).toEqual([firstWaiter])
    resolveClaudeReplayWaiter(session, userReplayFrame('replay-one', 'one'))
    await expect(first).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'replay-one' }
    })
  })

  // A write can reach Claude and still reject on the following flush.
  it('keeps an identity the replay already claimed when the send then rejects', async () => {
    const session = sessionFor()
    session.connection.send = vi.fn().mockImplementation(async () => {
      resolveClaudeReplayWaiter(session, userReplayFrame('landed-anyway', 'hello'))
      throw new Error('flush failed')
    })

    await expect(
      dispatchClaudeTurn(
        session,
        { clientMessageId: 'client-1', body: userMessage([{ type: 'text', text: 'hello' }]) },
        ACK_BUDGET_MS
      )
    ).resolves.toMatchObject({
      state: 'accepted',
      providerIdentity: { uuid: 'landed-anyway' }
    })
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
