import { describe, expect, it } from 'vitest'
import {
  PANE_AGENT_EVIDENCE_SOURCES,
  type PaneAgentEvidence,
  resolvePaneAgentIdentity
} from './pane-agent-identity-resolver'

const resolve = (evidence: PaneAgentEvidence[], extra = {}) =>
  resolvePaneAgentIdentity({ evidence, ...extra })

describe('resolvePaneAgentIdentity', () => {
  describe('a display title is the last thing consulted', () => {
    it.each(PANE_AGENT_EVIDENCE_SOURCES.filter((s) => s !== 'title' && s !== 'sibling'))(
      'lets %s outrank a conflicting title',
      (source) => {
        const result = resolve([
          { source: 'title', agent: 'codex' },
          { source, agent: 'grok' }
        ])
        expect(result.agent).toBe('grok')
        expect(result.source).toBe(source)
      }
    )

    it('uses the title only when nothing else is eligible', () => {
      expect(resolve([{ source: 'title', agent: 'codex' }])).toMatchObject({
        agent: 'codex',
        source: 'title'
      })
    })

    it('outranks the launch record with nothing weaker than the launch record', () => {
      // The tab ladder currently puts the parsed title ABOVE activeLaunchAgent, so a string Orca
      // parsed beats a fact Orca owns. That inversion cannot be expressed here.
      const result = resolve([
        { source: 'launch', agent: 'claude' },
        { source: 'title', agent: 'gemini' }
      ])
      expect(result.agent).toBe('claude')
    })
  })

  describe('run generation separates the bug from the legitimate reclaim', () => {
    // Both shapes are `completed hook = A, title = B`. Ordering alone cannot tell them apart.
    const shape = (hookRun: number, titleRun: number): PaneAgentEvidence[] => [
      { source: 'completed-hook', agent: 'claude', runId: hookRun },
      { source: 'title', agent: 'codex', runId: titleRun }
    ]

    it('keeps the completed hook when both belong to the current run', () => {
      // The reported bug: nothing new started, so the hook is still the truth.
      const result = resolvePaneAgentIdentity({ evidence: shape(7, 7), currentRunId: 7 })
      expect(result).toMatchObject({ agent: 'claude', source: 'completed-hook' })
      expect(result.supersededSources).toEqual([])
    })

    it('drops the completed hook once a new run has started', () => {
      // The legitimate reclaim: the pane was reused, so run 7's hook describes an agent that is
      // no longer there. It is ineligible, not merely outranked.
      const result = resolvePaneAgentIdentity({ evidence: shape(7, 8), currentRunId: 8 })
      expect(result).toMatchObject({ agent: 'codex', source: 'title' })
      expect(result.supersededSources).toEqual(['completed-hook'])
    })

    it('produces opposite answers from identical evidence, given only the run ids', () => {
      // The whole point, stated as one assertion.
      const bug = resolvePaneAgentIdentity({ evidence: shape(7, 7), currentRunId: 7 })
      const reclaim = resolvePaneAgentIdentity({ evidence: shape(7, 8), currentRunId: 8 })
      expect(bug.agent).not.toBe(reclaim.agent)
    })
  })

  describe('mixed-version peers', () => {
    it('treats evidence with no run id as eligible', () => {
      // An old host publishes no run ids. Treating unknown as stale would blank every row.
      const result = resolvePaneAgentIdentity({
        evidence: [{ source: 'completed-hook', agent: 'claude' }],
        currentRunId: 9
      })
      expect(result.agent).toBe('claude')
    })

    it('disables run filtering entirely when the pane has no current run', () => {
      const result = resolvePaneAgentIdentity({
        evidence: [{ source: 'completed-hook', agent: 'claude', runId: 3 }]
      })
      expect(result).toMatchObject({ agent: 'claude', supersededSources: [] })
    })
  })

  describe('siblings are tab-scoped', () => {
    it('ignores a sibling by default', () => {
      expect(resolve([{ source: 'sibling', agent: 'codex' }]).agent).toBeNull()
    })

    it('accepts a sibling when the caller opts in', () => {
      expect(resolve([{ source: 'sibling', agent: 'codex' }], { allowSibling: true }).agent).toBe(
        'codex'
      )
    })

    it('still ranks a sibling above a title', () => {
      const result = resolve(
        [
          { source: 'title', agent: 'grok' },
          { source: 'sibling', agent: 'codex' }
        ],
        { allowSibling: true }
      )
      expect(result.source).toBe('sibling')
    })
  })

  describe('no eligible evidence', () => {
    it('returns null rather than guessing', () => {
      expect(resolve([])).toMatchObject({ agent: null, source: null })
    })

    it('returns null when every source belongs to a superseded run', () => {
      const result = resolvePaneAgentIdentity({
        evidence: [
          { source: 'live-hook', agent: 'claude', runId: 1 },
          { source: 'title', agent: 'codex', runId: 1 }
        ],
        currentRunId: 2
      })
      expect(result.agent).toBeNull()
      expect(result.supersededSources).toEqual(['live-hook', 'title'])
    })
  })

  describe('input order does not decide the answer', () => {
    it('resolves the same regardless of how evidence is listed', () => {
      const evidence: PaneAgentEvidence[] = [
        { source: 'title', agent: 'codex' },
        { source: 'launch', agent: 'grok' },
        { source: 'live-hook', agent: 'claude' }
      ]
      const forward = resolve([...evidence])
      const reverse = resolve(evidence.toReversed())
      expect(forward).toEqual(reverse)
      expect(forward.source).toBe('live-hook')
    })
  })
})
