import { describe, expect, it } from 'vitest'
import {
  AGENT_INTERRUPT_HINT_TTL_MS,
  reconcileAgentInterruptHint,
  type AgentInterruptHint
} from './agent-interrupt-hint'

const HINT: AgentInterruptHint = {
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  prompt: 'long task',
  stateStartedAt: 900,
  agentType: 'opencode',
  recordedAt: 1_500
}

describe('reconcileAgentInterruptHint', () => {
  it('expires the hint when the same turn is still working', () => {
    expect(
      reconcileAgentInterruptHint({
        hint: HINT,
        now: 1_600,
        previousStateStartedAt: 900,
        incoming: {
          paneKey: HINT.paneKey,
          hookEventName: 'PostToolUse',
          payload: { state: 'working', prompt: 'long task', agentType: 'opencode' }
        }
      })
    ).toEqual({ hint: undefined, stampInterrupted: false })
  })

  it('stamps a lead done for agents that omit is_interrupt', () => {
    expect(
      reconcileAgentInterruptHint({
        hint: HINT,
        now: 1_501,
        previousStateStartedAt: 900,
        incoming: {
          paneKey: HINT.paneKey,
          payload: { state: 'done', prompt: 'long task', agentType: 'opencode' }
        }
      })
    ).toEqual({ hint: undefined, stampInterrupted: true })
  })

  it('does not override Claude Stop — is_interrupt absence is the hook contract', () => {
    expect(
      reconcileAgentInterruptHint({
        hint: { ...HINT, agentType: 'claude' },
        now: 1_501,
        previousStateStartedAt: 900,
        incoming: {
          paneKey: HINT.paneKey,
          hookEventName: 'Stop',
          payload: { state: 'done', prompt: 'long task', agentType: 'claude' }
        }
      })
    ).toEqual({ hint: undefined, stampInterrupted: false })
  })

  it('does not stamp a child stop onto the lead row', () => {
    expect(
      reconcileAgentInterruptHint({
        hint: HINT,
        now: 1_501,
        previousStateStartedAt: 900,
        incoming: {
          paneKey: HINT.paneKey,
          hookEventName: 'SubagentStop',
          toolAgentId: 'child-1',
          payload: { state: 'done', prompt: 'long task', agentType: 'opencode' }
        }
      })
    ).toEqual({ hint: HINT, stampInterrupted: false })
  })

  it('lets a delayed completion expire instead of inheriting the keystroke', () => {
    expect(
      reconcileAgentInterruptHint({
        hint: HINT,
        now: HINT.recordedAt + AGENT_INTERRUPT_HINT_TTL_MS + 1,
        previousStateStartedAt: 900,
        incoming: {
          paneKey: HINT.paneKey,
          payload: { state: 'done', prompt: 'long task', agentType: 'opencode' }
        }
      })
    ).toEqual({ hint: undefined, stampInterrupted: false })
  })
})
