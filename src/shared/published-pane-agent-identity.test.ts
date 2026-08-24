import { describe, expect, it } from 'vitest'
import { resolvePublishedPaneAgentIdentity } from './published-pane-agent-identity'

const resolve = resolvePublishedPaneAgentIdentity

describe('resolvePublishedPaneAgentIdentity', () => {
  describe('a task title cannot name the pane', () => {
    // Minimized from real recorded titles. Each is a pane of one agent whose task text names
    // another; before this, `@<other>` routing delivered to them.
    it.each([
      ['Switch Claude and Codex off the load balancer… - grok', 'grok'],
      ['Review the Claude session-history fix', 'codex'],
      ['✳ Fix the text cursor blink', 'claude']
    ])('keeps %j as its launched agent', (title, launchAgent) => {
      expect(resolve({ launchAgent: launchAgent as never, title })).toBe(launchAgent)
    })
  })

  it('keeps the launch record when an unambiguous title names a different agent', () => {
    // The ranking assertion. Every other case here either yields no title evidence or agrees with
    // the launch record, so without this one the suite passes even with title ranked FIRST —
    // verified by mutation. `✳ Claude Code` is a parseable, unambiguous Claude title, and it still
    // must not rename a pane Orca launched as Codex.
    expect(resolve({ launchAgent: 'codex', title: '✳ Claude Code' })).toBe('codex')
  })

  it('prefers the live foreground process to the launch record', () => {
    // The pane was launched as Claude and the user then started Codex in it. The process is the
    // more direct observation, so it wins.
    expect(resolve({ launchAgent: 'claude', foregroundAgent: 'codex' })).toBe('codex')
  })

  it('publishes nothing from a title alone, even an unambiguous one', () => {
    // Deliberate, and the sharpest trade in this change. What this publishes AUTHORIZES ACTIONS:
    // orchestration routing uses it to pick which real agent pane receives a message. A title is
    // a decoration channel, and a stale one outlives the agent that wrote it, so a pane whose only
    // evidence is a parsed string publishes no identity and every action consumer fails closed.
    //
    // The cost: a hook-less agent over SSH that Orca did not launch, and whose foreground process
    // the host cannot read, is not addressable by @agent. That is a real capability loss, accepted
    // because a message delivered into the wrong agent's prompt is not recoverable and an
    // undelivered one is — the sender sees zero recipients.
    expect(resolve({ title: '✳ Claude Code' })).toBeUndefined()
  })

  it('publishes nothing when the title names no agent unambiguously', () => {
    // Absence is meaningful: it tells a caller to fail closed rather than guess.
    expect(resolve({ title: '◐ Rebase PR #14624 onto main' })).toBeUndefined()
    expect(resolve({ title: 'Fix the codex bug' })).toBeUndefined()
    expect(resolve({})).toBeUndefined()
  })

  it('publishes nothing for a hyphenated worktree name that contains an agent word', () => {
    expect(resolve({ title: 'review-14600-codex' })).toBeUndefined()
  })
})
