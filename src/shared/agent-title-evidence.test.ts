import { describe, expect, it } from 'vitest'
import { collectAgentTitleEvidence } from './agent-title-evidence'

const agentFor = (title: string) => collectAgentTitleEvidence(title).agent
const reasonFor = (title: string) => collectAgentTitleEvidence(title).reason

describe('collectAgentTitleEvidence', () => {
  describe('an anchored name outranks a name in task text', () => {
    // Minimized from real recorded titles that resolve to the wrong agent on the ordered chain:
    // the pane owner is named by Orca's `- <agent>` suffix, the competitor only by task text.
    it.each([
      'Switch Claude and Codex off the load balancer… - grok',
      'Codex structured chat revalidation… - grok',
      '⠸ - Thinking - Codex native-chat work… - grok',
      'Electron QA: check the Gemini label… - grok'
    ])('resolves %j to the suffix owner', (title) => {
      expect(agentFor(title)).toBe('grok')
    })

    it('does not read a hyphenated worktree name as an owner suffix', () => {
      // `review-14600-codex` is a directory, not an owner declaration. The suffix grammar
      // requires whitespace before the dash precisely to keep these apart.
      expect(agentFor('review-14600-codex')).toBeNull()
      expect(agentFor('codex-split-core')).toBeNull()
    })
  })

  describe('order independence', () => {
    // The defect this replaces is that chain position decides between two names. Swapping the
    // two names in a title must not change the answer.
    it.each([
      ['codex', 'grok'],
      ['gemini', 'antigravity'],
      ['copilot', 'devin'],
      ['claude', 'cursor']
    ])('gives %s + %s the same answer in both orders', (a, b) => {
      const forward = collectAgentTitleEvidence(`${a} and ${b}`)
      const reverse = collectAgentTitleEvidence(`${b} and ${a}`)
      expect(forward.agent).toBe(reverse.agent)
      expect(forward.agent).toBeNull()
      expect([...forward.freeTextNames].sort()).toEqual([...reverse.freeTextNames].sort())
    })
  })

  describe('a vendor marker is evidence the agent emitted, not text a human typed', () => {
    it('keeps a Claude pane Claude when its task text names another agent', () => {
      // 13 recorded titles have this shape. The sigil is emitted by Claude; the name is typed.
      expect(agentFor('✳ Fix Codex false attention notifications on Windows')).toBe('claude')
      expect(reasonFor('✳ Consolidate Codex subagent sidebar rows')).toBe('vendor-marker')
    })

    it('lets an anchored name outrank a foreign vendor marker', () => {
      // `agy` is the entire undecorated remainder — the strongest name evidence a title carries —
      // so it wins against Claude's sigil rather than losing to it by position.
      expect(agentFor('✳ agy')).toBe('antigravity')
      expect(reasonFor('✳ agy')).toBe('anchored')
    })

    it('keeps an OpenCode envelope OpenCode when its session text names another agent', () => {
      expect(agentFor('OC | QA PR #14582 Cursor sidecar SSH arms')).toBe('opencode')
    })
  })

  describe('Antigravity model names are metadata, not identity', () => {
    it('reads an identity segment plus a model name as Antigravity', () => {
      expect(agentFor('agy · Gemini 3.7 Flash')).toBe('antigravity')
      expect(agentFor('Antigravity — Gemini 3.7 Flash')).toBe('antigravity')
    })

    it('declines a bare model name rather than guessing Gemini CLI', () => {
      // No identity segment, no vendor glyph — only a name in free text. Antigravity and Gemini
      // CLI are equally consistent with it, so the title cannot answer.
      expect(agentFor('Gemini 3.7 Flash · high')).toBeNull()
    })

    it('still resolves a real Gemini glyph', () => {
      expect(agentFor('✦ Refactor the parser')).toBe('gemini')
    })
  })

  describe('a name in free text alone is never identity', () => {
    it.each([
      '◐ DaemonConnectionLostError with 70 Codex agents',
      'Fix the grok hook',
      'Debug the cursor sidecar'
    ])('declines %j', (title) => {
      expect(agentFor(title)).toBeNull()
      expect(reasonFor(title)).toBe('free-text-only')
    })
  })

  it('produces no name evidence for an agent outside the token set', () => {
    // The token set is deliberately narrower than the agent union: short names like `omp` would
    // classify ordinary shell text. Such a title yields no evidence at all rather than a guess.
    expect(reasonFor('Review PR for OMP transcript rendering')).toBe('no-evidence')
  })

  describe('activity is not identity', () => {
    it.each(['◐ Rebase PR #14624 onto main', '⠂ Fix SSH fallback', '⠋ Thinking'])(
      'declines the spinner-only title %j',
      (title) => {
        // Braille and quarter-circle spinners are emitted by many agents, so they prove the pane
        // is busy and nothing about who it is. Callers that want busy-ness use activity parsing.
        expect(agentFor(title)).toBeNull()
        expect(reasonFor(title)).toBe('no-evidence')
      }
    )
  })

  describe('conflicting evidence of the same class resolves to nothing', () => {
    it('declines two anchored names', () => {
      expect(reasonFor('OC | something… - grok')).toBe('conflicting-anchored-names')
    })

    it('declines two vendor markers', () => {
      expect(reasonFor('✳ ✦ two sigils')).toBe('conflicting-vendor-markers')
    })
  })

  it('declines a Claude management screen', () => {
    expect(agentFor('claude agents')).toBeNull()
  })
})
