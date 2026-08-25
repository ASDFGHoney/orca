import { describe, expect, it } from 'vitest'
import {
  PANE_AGENT_DISPLAY_POLICIES,
  type PaneAgentEvidence,
  type PaneAgentRun,
  resolvePaneAgentDisplayIdentity
} from './pane-agent-identity-resolver'

const currentRun: PaneAgentRun = { hostAuthorityId: 'host-1', generation: 8 }
const previousRun: PaneAgentRun = { hostAuthorityId: 'host-1', generation: 7 }
const otherHostRun: PaneAgentRun = { hostAuthorityId: 'host-2', generation: 8 }

const resolveFocused = (evidence: PaneAgentEvidence[], extra = {}) =>
  resolvePaneAgentDisplayIdentity({ policy: 'focused-pane', evidence, ...extra })

describe('resolvePaneAgentDisplayIdentity', () => {
  describe('named display policies', () => {
    it.each(PANE_AGENT_DISPLAY_POLICIES['focused-pane'].filter((s) => s !== 'title'))(
      'lets focused-pane %s outrank a conflicting title',
      (source) => {
        expect(
          resolveFocused([
            { source: 'title', agent: 'codex' },
            { source, agent: 'grok' }
          ])
        ).toMatchObject({ kind: 'resolved', agent: 'grok', source })
      }
    )

    it('lets a host-observed process override Orca launch intent', () => {
      expect(
        resolveFocused([
          { source: 'launch', agent: 'claude' },
          { source: 'process', agent: 'codex' }
        ])
      ).toMatchObject({ kind: 'resolved', agent: 'codex', source: 'process' })
    })

    it('keeps sibling evidence out of focused-pane identity', () => {
      expect(resolveFocused([{ source: 'sibling', agent: 'codex' }])).toEqual({
        kind: 'unresolved',
        reason: 'no-evidence'
      })
    })

    it('uses sibling only after the active pane title for a tab aggregate', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'tab-aggregate',
          evidence: [
            { source: 'sibling', agent: 'codex' },
            { source: 'title', agent: 'grok' }
          ]
        })
      ).toMatchObject({ kind: 'resolved', agent: 'grok', source: 'title' })
    })
  })

  describe('host-owned agent-run identity', () => {
    const shape = (hookRun: PaneAgentRun, titleRun: PaneAgentRun): PaneAgentEvidence[] => [
      { source: 'completed-hook', agent: 'claude', run: hookRun },
      { source: 'title', agent: 'codex', run: titleRun }
    ]

    it('keeps the completed hook when both observations belong to the current run', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: shape(currentRun, currentRun),
          currentRun
        })
      ).toEqual({
        kind: 'resolved',
        agent: 'claude',
        source: 'completed-hook',
        runScope: 'current'
      })
    })

    it('drops the completed hook after positive evidence advances the agent run', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: shape(previousRun, currentRun),
          currentRun
        })
      ).toEqual({
        kind: 'resolved',
        agent: 'codex',
        source: 'title',
        runScope: 'current'
      })
    })

    it('includes host authority rather than comparing naked generation numbers', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: [
            { source: 'completed-hook', agent: 'claude', run: otherHostRun },
            { source: 'title', agent: 'codex', run: currentRun }
          ],
          currentRun
        })
      ).toMatchObject({ kind: 'resolved', agent: 'codex', source: 'title' })
    })
  })

  describe('mixed-version display evidence', () => {
    it('preserves source authority when a stronger source cannot publish a run', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: [
            { source: 'live-hook', agent: 'claude' },
            { source: 'title', agent: 'codex', run: currentRun }
          ],
          currentRun
        })
      ).toEqual({
        kind: 'resolved',
        agent: 'claude',
        source: 'live-hook',
        runScope: 'compatibility'
      })
    })

    it('uses exact current-run scope as a tie-breaker within one source', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: [
            { source: 'live-hook', agent: 'claude', run: currentRun },
            { source: 'live-hook', agent: 'codex' }
          ],
          currentRun
        })
      ).toEqual({
        kind: 'resolved',
        agent: 'claude',
        source: 'live-hook',
        runScope: 'current'
      })
    })

    it('disables run filtering when the peer has no current run identity', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: [{ source: 'completed-hook', agent: 'claude', run: previousRun }]
        })
      ).toMatchObject({ kind: 'resolved', agent: 'claude', runScope: 'compatibility' })
    })
  })

  describe('equal-source ordering', () => {
    const conflict: PaneAgentEvidence[] = [
      { source: 'live-hook', agent: 'claude' },
      { source: 'live-hook', agent: 'codex' },
      { source: 'title', agent: 'grok' }
    ]

    it('refuses incomparable claims instead of letting a weaker source decide', () => {
      expect(resolveFocused(conflict)).toEqual({
        kind: 'unresolved',
        reason: 'conflicting-evidence',
        source: 'live-hook'
      })
    })

    it('does not let input order break an incomparable tie', () => {
      expect(resolveFocused(conflict)).toEqual(resolveFocused(conflict.toReversed()))
    })

    it('chooses the newest observation sequenced by one authority', () => {
      const evidence: PaneAgentEvidence[] = [
        {
          source: 'process',
          agent: 'claude',
          order: { authorityId: 'main', revision: 4 }
        },
        {
          source: 'process',
          agent: 'codex',
          order: { authorityId: 'main', revision: 5 }
        }
      ]
      expect(resolveFocused(evidence)).toMatchObject({
        kind: 'resolved',
        agent: 'codex',
        source: 'process'
      })
      expect(resolveFocused(evidence)).toEqual(resolveFocused(evidence.toReversed()))
    })

    it('refuses ordering claims from different authorities', () => {
      expect(
        resolveFocused([
          {
            source: 'process',
            agent: 'claude',
            order: { authorityId: 'main', revision: 5 }
          },
          {
            source: 'process',
            agent: 'codex',
            order: { authorityId: 'renderer', revision: 6 }
          }
        ])
      ).toMatchObject({ kind: 'unresolved', reason: 'conflicting-evidence' })
    })

    it('refuses different agents tied at the same authoritative revision', () => {
      expect(
        resolveFocused([
          {
            source: 'live-hook',
            agent: 'claude',
            order: { authorityId: 'main', revision: 5 }
          },
          {
            source: 'live-hook',
            agent: 'codex',
            order: { authorityId: 'main', revision: 5 }
          }
        ])
      ).toMatchObject({ kind: 'unresolved', reason: 'conflicting-evidence' })
    })

    it('accepts duplicate observations that agree', () => {
      expect(
        resolveFocused([
          { source: 'process', agent: 'codex' },
          { source: 'process', agent: 'codex' }
        ])
      ).toMatchObject({ kind: 'resolved', agent: 'codex', source: 'process' })
    })
  })

  describe('unresolved and run-boundary states', () => {
    it('returns no-evidence for an empty display input', () => {
      expect(resolveFocused([])).toEqual({ kind: 'unresolved', reason: 'no-evidence' })
    })

    it('returns run-transition when every ranked observation is superseded', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: [
            { source: 'live-hook', agent: 'claude', run: previousRun },
            { source: 'title', agent: 'codex', run: previousRun }
          ],
          currentRun
        })
      ).toEqual({ kind: 'unresolved', reason: 'run-transition' })
    })

    it('resolves as soon as the positive evidence for the new run is present', () => {
      expect(
        resolvePaneAgentDisplayIdentity({
          policy: 'focused-pane',
          evidence: [
            { source: 'completed-hook', agent: 'claude', run: previousRun },
            { source: 'launch', agent: 'codex', run: currentRun }
          ],
          currentRun
        })
      ).toMatchObject({ kind: 'resolved', agent: 'codex', source: 'launch' })
    })
  })

  it('does not let input order decide between different sources', () => {
    const evidence: PaneAgentEvidence[] = [
      { source: 'title', agent: 'codex' },
      { source: 'launch', agent: 'grok' },
      { source: 'live-hook', agent: 'claude' }
    ]
    expect(resolveFocused(evidence)).toEqual(resolveFocused(evidence.toReversed()))
    expect(resolveFocused(evidence)).toMatchObject({
      kind: 'resolved',
      agent: 'claude',
      source: 'live-hook'
    })
  })
})
