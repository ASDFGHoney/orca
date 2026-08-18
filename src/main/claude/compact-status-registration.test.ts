import { describe, expect, it } from 'vitest'

import {
  createHookListenerState,
  normalizeHookPayload,
  type AgentHookEventPayload,
  type HookListenerState
} from '../../shared/agent-hook-listener'
import { makePaneKey } from '../../shared/stable-pane-id'
import { applyManagedHooks, CLAUDE_EVENTS } from './hook-settings'

const PANE_KEY = makePaneKey('compact-registration', '11111111-1111-4111-8111-111111111111')
const TURN_PROMPT_ID = '22222222-2222-4222-8222-222222222222'
const COMPACT_PROMPT_ID = '33333333-3333-4333-8333-333333333333'

const REGISTERED_EVENT_NAMES = new Set<string>(CLAUDE_EVENTS.map((event) => event.eventName))

/** Deliver a hook event the way production does: only if the event is actually REGISTERED with
 *  Claude. Feeding the normalizer directly is what let a whole compact-correlation feature ship
 *  green while being unreachable — every behavior assertion here goes through this gate. */
function deliverIfRegistered(
  state: HookListenerState,
  payload: Record<string, unknown>
): AgentHookEventPayload | null {
  if (!REGISTERED_EVENT_NAMES.has(payload.hook_event_name as string)) {
    return null
  }
  const event = normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
  if (event) {
    state.lastStatusByPaneKey.set(PANE_KEY, event)
  }
  return event
}

function hook(name: string, promptId: string, extra: Record<string, unknown> = {}) {
  return { hook_event_name: name, prompt_id: promptId, session_id: 'session-a', ...extra }
}

/** The exact sequence Claude Code emits for a successful manual /compact, measured from a PTY-driven
 *  interactive session (2.1.227). PreCompact and the summarizer's start-less SubagentStop are part
 *  of the real stream, so they are delivered here even though only PostCompact is registered. */
function successfulManualCompact(state: HookListenerState) {
  deliverIfRegistered(state, hook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
  deliverIfRegistered(
    state,
    hook('SubagentStop', COMPACT_PROMPT_ID, {
      agent_id: 'a75b38b59774e1f31',
      agent_type: '',
      background_tasks: [],
      session_crons: []
    })
  )
  deliverIfRegistered(state, hook('SessionStart', COMPACT_PROMPT_ID, { source: 'compact' }))
  return deliverIfRegistered(state, hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))
}

function startTurn(state: HookListenerState) {
  deliverIfRegistered(state, hook('UserPromptSubmit', TURN_PROMPT_ID, { prompt: 'do the thing' }))
}

describe('Claude compact hook registration', () => {
  it('registers PostCompact and deliberately does not register PreCompact', () => {
    expect(REGISTERED_EVENT_NAMES.has('PostCompact')).toBe(true)
    // Why: PreCompact fires BEFORE the compact is validated and an aborted compact emits it alone,
    // so subscribing to it at all is what strands the pane. This assertion is the guard.
    expect(REGISTERED_EVENT_NAMES.has('PreCompact')).toBe(false)
  })

  it('writes PostCompact, and no PreCompact, into the settings Claude actually reads', () => {
    const written = applyManagedHooks(
      { hooks: {} },
      { type: 'command', command: 'orca-claude-hook' },
      'claude-hook.sh'
    )
    const postCompact = written.hooks?.PostCompact ?? []
    expect(
      postCompact.some((definition) =>
        (definition.hooks ?? []).some((entry) => entry.command === 'orca-claude-hook')
      )
    ).toBe(true)
    expect(written.hooks?.PreCompact).toBeUndefined()
  })
})

describe('STA-2915: a manual compact clears the pane', () => {
  it('ends a stuck working row as a silent done', () => {
    const state = createHookListenerState()
    startTurn(state)
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')

    const completion = successfulManualCompact(state)

    expect(completion?.payload.state).toBe('done')
    // Why: a finished compact is a session-shaped boundary, not a completed turn — consumers that
    // react to completion (automation runs, unread counts, notifications) must stay out of it.
    expect(completion?.payload.sessionBoundary).toBe(true)
  })

  it('keeps the summarizer SubagentStop from being the thing that resolves the pane', () => {
    const state = createHookListenerState()
    startTurn(state)
    // The start-less SubagentStop re-emits the cached lead state; it can only republish `working`,
    // never clear it. Only PostCompact resolves the pane.
    const republished = deliverIfRegistered(
      state,
      hook('SubagentStop', COMPACT_PROMPT_ID, {
        agent_id: 'a75b38b59774e1f31',
        agent_type: '',
        background_tasks: [],
        session_crons: []
      })
    )
    expect(republished?.payload.state).toBe('working')
  })
})

describe('STA-4613: an aborted compact must not strand the pane', () => {
  it('leaves an idle pane idle when PreCompact arrives alone', () => {
    const state = createHookListenerState()
    startTurn(state)
    deliverIfRegistered(state, hook('Stop', TURN_PROMPT_ID))
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('done')

    // Measured: "Not enough messages to compact" emits PreCompact and nothing else.
    deliverIfRegistered(state, hook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))

    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('done')
  })

  it('leaves a working pane working when PreCompact arrives alone', () => {
    const state = createHookListenerState()
    startTurn(state)

    deliverIfRegistered(state, hook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' }))

    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')
  })

  it('does not map PreCompact even when it is delivered past the registration gate', () => {
    const state = createHookListenerState()
    startTurn(state)
    deliverIfRegistered(state, hook('Stop', TURN_PROMPT_ID))

    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: hook('PreCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
      },
      'production'
    )

    expect(event).toBeNull()
  })
})

describe('an auto compact claims nothing', () => {
  it('leaves the in-flight turn alone and lets its own Stop close it', () => {
    const state = createHookListenerState()
    startTurn(state)

    const autoCompact = deliverIfRegistered(
      state,
      hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'auto' })
    )

    expect(autoCompact).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')

    deliverIfRegistered(state, hook('Stop', TURN_PROMPT_ID))
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('done')
  })
})

describe('compact completion guards', () => {
  it('does not resurrect a pane that was retired before the completion arrived', () => {
    const state = createHookListenerState()
    // No cached status: the pane was closed/cleared. A compact clears a row, it never creates one.
    expect(successfulManualCompact(state)).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)).toBeUndefined()
  })

  it('clears a stuck row restored from disk after a restart, despite a stale connection id', () => {
    const state = createHookListenerState()
    startTurn(state)
    const stuck = state.lastStatusByPaneKey.get(PANE_KEY)!
    // What hydration produces after an Orca update: the row survives, its connectionId is the
    // PREVIOUS session's, and it is flagged as restored-but-unconfirmed.
    state.lastStatusByPaneKey.set(PANE_KEY, {
      ...stuck,
      connectionId: 'a-previous-connection',
      restoredUnconfirmed: true
    })

    const completion = successfulManualCompact(state)

    expect(completion?.payload.state).toBe('done')
    expect(completion?.payload.sessionBoundary).toBe(true)
  })

  it('clears a restored row that predates provider-session persistence', () => {
    const state = createHookListenerState()
    startTurn(state)
    const stuck = state.lastStatusByPaneKey.get(PANE_KEY)!
    state.lastStatusByPaneKey.set(PANE_KEY, {
      ...stuck,
      providerSession: undefined,
      connectionId: 'a-previous-connection',
      restoredUnconfirmed: true
    })

    expect(successfulManualCompact(state)?.payload.state).toBe('done')
  })

  it('does not clear a live turn owned by a different Claude session', () => {
    const state = createHookListenerState()
    startTurn(state)

    const foreign = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostCompact',
          prompt_id: COMPACT_PROMPT_ID,
          session_id: 'a-different-session',
          trigger: 'manual'
        }
      },
      'production'
    )

    expect(foreign).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')
  })

  it('rejects a compact completion with no provider prompt id', () => {
    const state = createHookListenerState()
    startTurn(state)

    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'PostCompact', session_id: 'session-a', trigger: 'manual' }
      },
      'production'
    )

    expect(event).toBeNull()
  })

  it('applies a compact completion once, so a duplicate cannot refresh the row', () => {
    const state = createHookListenerState()
    startTurn(state)
    expect(successfulManualCompact(state)?.payload.state).toBe('done')

    const duplicate = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: hook('PostCompact', COMPACT_PROMPT_ID, { trigger: 'manual' })
      },
      'production'
    )

    expect(duplicate).toBeNull()
  })
})
