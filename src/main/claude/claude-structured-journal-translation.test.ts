import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudePendingPrompt } from './claude-structured-prompt-replies'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function sinkState() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: (identity) => tombstones.push(identity),
    publish: vi.fn()
  }
  return { sink, items, tombstones }
}

function message(
  type: 'assistant' | 'user',
  uuid: string,
  content: unknown[],
  parentToolUseId: string | null = null
) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type,
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: parentToolUseId,
      message: { role: type, content }
    }
  }
}

describe('Claude structured journal translation', () => {
  it('reuses the shared coalescer and finalizes the provider-keyed message row', () => {
    const state = sinkState()
    let scheduled: (() => void) | null = null
    const translator = createClaudeJournalTranslator({
      sink: state.sink,
      schedule: (run, delay) => {
        expect(delay).toBe(60)
        scheduled = run
        return () => {
          scheduled = null
        }
      }
    })

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'stream_event',
        uuid: 'assistant-1',
        session_id: 'claude-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }
      }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'stream_event',
        uuid: 'assistant-1',
        session_id: 'claude-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }
      }
    })
    expect(state.items).toEqual([])

    const run = scheduled as (() => void) | null
    run?.()
    expect(state.items.at(-1)).toEqual({
      identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'assistant-1' },
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }] }
    })

    translator.handle(message('assistant', 'assistant-1', [{ type: 'text', text: 'Hello!' }]))
    expect(state.items.at(-1)).toEqual({
      identity: { provider: 'claude', sessionId: 'claude-session', uuid: 'assistant-1' },
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Hello!' }] }
    })
  })

  it('journals turn lifecycle and updates one tool row through its result', () => {
    const state = sinkState()
    const translator = createClaudeJournalTranslator({ sink: state.sink })

    translator.handle(message('user', 'user-1', [{ type: 'text', text: 'List files' }]))
    translator.handle(
      message('assistant', 'assistant-tool', [
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }
      ])
    )
    translator.handle(
      message(
        'user',
        'tool-result-1',
        [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'a.ts\nb.ts' }],
        'tool-1'
      )
    )

    const keyed = new Map(
      state.items.map((item) => [agentJournalItemKey(item.identity), item.body])
    )
    expect(keyed.get('claude:claude-session:user-1')).toMatchObject({
      kind: 'message',
      role: 'user'
    })
    expect(keyed.get('orca:claude-tool%3Aclaude-session%3Atool-1')).toMatchObject({
      kind: 'tool-call',
      name: 'Bash',
      state: 'completed',
      output: { head: 'a.ts\nb.ts', truncated: false }
    })
    expect(
      state.items.some(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle?.turnId === 'user-1'
      )
    ).toBe(true)

    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { type: 'result', session_id: 'claude-session', uuid: 'result-1' }
    })
    expect(state.tombstones.at(-1)).toMatchObject({
      provider: 'legacy',
      agent: 'claude',
      recordId: 'turn-lifecycle:user-1'
    })
  })

  it('creates addressable approval and multi-question cards and cancels them durably', () => {
    const state = sinkState()
    const bindings: unknown[][] = []
    const translator = createClaudeJournalTranslator({
      sink: state.sink,
      bindPromptItemId: (...args) => bindings.push(args)
    })
    const approval = prompt({
      requestId: 'permission-1',
      promptKey: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      kind: 'approval',
      input: { command: 'git status' },
      questionIds: []
    })
    translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt: approval })
    expect(state.items.at(-1)?.body).toMatchObject({
      kind: 'approval',
      title: 'Allow Bash?',
      options: expect.arrayContaining([{ id: 'allow', label: 'Allow' }])
    })
    expect(bindings[0]).toEqual([
      'orca:claude-prompt%3Aorca-session%3Apermission-1',
      'permission-1'
    ])

    const questions = prompt({
      requestId: 'questions-1',
      promptKey: 'questions-1',
      toolUseId: 'tool-q',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: {
        questions: [
          { question: 'Library?', options: [{ label: 'Luxon' }] },
          { question: 'Ship?', options: [{ label: 'Yes' }] }
        ]
      },
      questionIds: ['Library?', 'Ship?']
    })
    translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt: questions })
    expect(state.items.filter((item) => item.body.kind === 'question')).toHaveLength(2)
    expect(bindings.at(-1)).toEqual([
      'orca:claude-prompt%3Aorca-session%3Aquestions-1%3AShip%3F',
      'questions-1',
      'Ship?'
    ])

    translator.handle({
      type: 'prompt-cancelled',
      sessionId: 'orca-session',
      promptKey: 'questions-1'
    })
    expect(state.tombstones).toHaveLength(2)
  })
})

function prompt(
  input: Pick<
    ClaudePendingPrompt,
    'requestId' | 'promptKey' | 'toolUseId' | 'toolName' | 'kind' | 'input' | 'questionIds'
  >
): ClaudePendingPrompt {
  return {
    ...input,
    suggestions: [],
    answers: new Map(),
    request: { subtype: 'can_use_tool' }
  }
}
