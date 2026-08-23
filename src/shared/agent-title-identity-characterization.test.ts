import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'

/**
 * Characterization of `getAgentLabel` before the identity refactor.
 *
 * `getAgentLabel` is an ordered first-match-wins scan of substring predicates over a display
 * title, so chain position — not evidence strength — decides identity. These tests pin the
 * current answers, including the wrong ones, so the resolver change shows up as a reviewable
 * diff of assertions rather than as silent behavior drift.
 *
 * Cases marked DEFECT are minimized from real recorded pane titles
 * (`terminal-history/<id>/checkpoint.json` -> `lastTitle`). At the time of writing the live
 * corpus held 2,846 checkpoints / 1,084 populated titles / 747 distinct, of which 5 real titles
 * resolved to the wrong agent. Task text is minimized here; the corpus stays local.
 */

/** Orca's own owner suffix: the agent that owns the pane is named after the final `- `. */
const ownerSuffix = (task: string, agent: string): string => `${task}… - ${agent}`

describe('getAgentLabel — characterization (pre-refactor)', () => {
  describe('the owner suffix loses to a foreign name in task text', () => {
    // DEFECT. In each case the pane owner is Grok, named by Orca's own `- grok` suffix
    // grammar, while the competing agent appears only inside free-form task text. Codex is
    // checked before Grok, so the weaker evidence wins.
    it.each([
      ['Switch Claude and Codex off the load balancer', 'Codex'],
      ['Codex structured chat revalidation', 'Codex'],
      ['Swap Codex off the load balancer', 'Codex']
    ])('reads %j as %s instead of Grok', (task, current) => {
      expect(getAgentLabel(ownerSuffix(task, 'grok'))).toBe(current)
    })

    it('reads a spinner-prefixed Grok pane as Codex', () => {
      // DEFECT. Real shape: a status spinner and phase precede the task text.
      expect(getAgentLabel(`⠸ - Thinking - ${ownerSuffix('Codex native-chat work', 'grok')}`)).toBe(
        'Codex'
      )
    })

    it('reads a Grok pane as Gemini CLI when its task text names two other agents', () => {
      // DEFECT, and the inverse of the reported Antigravity bug: the pane is Grok, the task
      // text mentions Antigravity and Gemini, and Gemini CLI is checked earliest of the three.
      expect(
        getAgentLabel(ownerSuffix('Electron QA: Antigravity tab vs Gemini label', 'grok'))
      ).toBe('Gemini CLI')
    })

    it('resolves the owner suffix correctly only when no earlier agent is named', () => {
      // Why this passes today: nothing earlier in the chain matches, so position never comes up.
      expect(getAgentLabel(ownerSuffix('Fix the sidebar row', 'grok'))).toBe('Grok')
    })
  })

  describe('a hyphenated worktree name is correctly not identity', () => {
    // Not a defect — pinned so the resolver does not start claiming these.
    it.each(['review-14600-codex', 'sta4779-review-codex', 'codex-split-core'])(
      'declines %j',
      (title) => {
        expect(getAgentLabel(title)).toBeNull()
      }
    )
  })

  describe('chain position, not evidence strength, decides between two names', () => {
    // The pairwise property: whichever agent is checked first wins, regardless of which one
    // the title's grammar actually identifies. Both orderings of the same pair agree, which is
    // the tell — the title carries no signal that distinguishes them.
    it.each([
      ['codex', 'grok', 'Codex'],
      ['grok', 'codex', 'Codex'],
      ['gemini', 'antigravity', 'Gemini CLI'],
      ['antigravity', 'gemini', 'Gemini CLI'],
      ['copilot', 'devin', 'GitHub Copilot'],
      ['devin', 'copilot', 'GitHub Copilot']
    ])('%s + %s both resolve to %s', (first, second, winner) => {
      expect(getAgentLabel(`${first} and ${second}`)).toBe(winner)
    })
  })

  describe('a vendor glyph is claimed by whichever check sits earliest', () => {
    it('claims a Claude glyph even when the task text names another agent', () => {
      // Correct today (the pane really is Claude) but for the wrong reason: the glyph is not
      // consulted as vendor evidence, the `✳ ` prefix branch simply sits first.
      expect(getAgentLabel('✳ Fix Codex false attention notifications on Windows')).toBe(
        'Claude Code'
      )
    })

    it('gives a bare agent name no way to outrank an earlier glyph check', () => {
      // DEFECT. `agy` is the entire undecorated remainder — the strongest possible name
      // evidence — and still loses to Claude's prefix glyph.
      expect(getAgentLabel('✳ agy')).toBe('Claude Code')
    })
  })

  describe('Antigravity model names are read as Gemini CLI', () => {
    it('reads an Antigravity model title as Gemini CLI', () => {
      // DEFECT. Antigravity models are named `Gemini <n.n> <Name>`, so an agy pane's own title
      // carries a whole `gemini` token, and Gemini CLI is checked first.
      expect(getAgentLabel('Gemini 3.7 Flash · high')).toBe('Gemini CLI')
    })

    it('still reads Gemini CLI even when the Antigravity name is also present', () => {
      // DEFECT. `AGY_AGENT_NAME_RE` is checked in the Antigravity branch at position 12, so an
      // explicit `agy` identity segment cannot outrank the model name at position 4. This is the
      // case PR #15535 patches by teaching the Gemini detector to decline; the resolver instead
      // treats the agy segment as the anchored identity and `Gemini <n.n> <Name>` as metadata.
      expect(getAgentLabel('agy · Gemini 3.7 Flash')).toBe('Gemini CLI')
    })
  })
})
