// DUAL-RECORD EVIDENCE for the stats migration (#10201 / STA-2445).
//
// Runs the legacy OSC-title AgentDetector and the canonical hook-transition
// recorder side by side over the same three scenarios, each feeding a REAL
// StatsCollector, and compares the resulting aggregates. This file exists to
// justify the switch; it is deleted together with agent-detector.ts.
//
// Observed delta (see `aggregate delta` case at the bottom):
//                                  title detector   canonical
//   hook-only agent                       0             1     <- detector MISSES
//   braille-spinner non-agent TUI         1             0     <- detector PHANTOM
//   one agent, one reconnect              2             1     <- detector DOUBLE-COUNTS
//   totals                                3             2
//
// The detector's higher total is not better coverage: two of its three are
// wrong, and the one real agent is the one it never saw.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentDetector } from './agent-detector'
import { AgentSessionTransitionRecorder } from './agent-session-transition-recorder'
import type { AgentSessionStatusEvent } from './agent-session-transition-recorder'
import { StatsCollector } from './collector'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

const T = 1_700_000_000_000

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-stats-compare-'))
  vi.useFakeTimers({ now: T })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataDir, { recursive: true, force: true })
})

function osc(title: string): string {
  return `\x1b]0;${title}\x07`
}

function hook(
  paneKey: string,
  state: 'working' | 'done',
  stateStartedAt: number,
  extra: Partial<AgentSessionStatusEvent> = {}
): AgentSessionStatusEvent {
  return {
    paneKey,
    connectionId: null,
    stateStartedAt,
    payload: { state },
    ...extra
  }
}

type Totals = { spawned: number; timeMs: number }

function totals(collector: StatsCollector): Totals {
  const summary = collector.getSummary()
  return { spawned: summary.totalAgentsSpawned, timeMs: summary.totalAgentTimeMs }
}

/** Legacy pipeline: raw PTY bytes -> OSC title -> AgentDetector -> StatsCollector. */
function runTitlePipeline(drive: (detector: AgentDetector) => void): Totals {
  const collector = new StatsCollector()
  drive(new AgentDetector(collector))
  return totals(collector)
}

/** Canonical pipeline: agent-hook status transitions -> recorder -> StatsCollector. */
function runCanonicalPipeline(drive: (recorder: AgentSessionTransitionRecorder) => void): Totals {
  const collector = new StatsCollector()
  drive(new AgentSessionTransitionRecorder(collector))
  return totals(collector)
}

describe('stats pipeline comparison: OSC title detector vs canonical hook transitions', () => {
  it('hook-only agent: the title detector counts 0, the canonical path counts 1', () => {
    // An agent whose CLI never writes an agent-shaped OSC title. The pane shows
    // an ordinary shell title while the agent reports working/done over hooks.
    const title = runTitlePipeline((detector) => {
      detector.onData('pty-a', osc('~/projects/site — bash'), T)
      detector.onData('pty-a', 'building the feature\r\n', T + 1_000)
      detector.onExit('pty-a')
    })
    const canonical = runCanonicalPipeline((recorder) => {
      recorder.onStatus(hook('pane-a', 'working', T))
      recorder.onStatus(hook('pane-a', 'done', T + 180_000))
    })

    expect(title).toEqual({ spawned: 0, timeMs: 0 })
    expect(canonical).toEqual({ spawned: 1, timeMs: 180_000 })
  })

  it('braille-spinner non-agent TUI: the title detector counts 1, the canonical path counts 0', () => {
    // detectAgentStatusFromTitle returns 'working' for ANY braille glyph, with no
    // agent-name requirement (agent-title-status.ts:192). A bundler progress
    // spinner is therefore indistinguishable from an agent to the title path.
    const title = runTitlePipeline((detector) => {
      detector.onData('pty-b', osc('⠋ npm run build'), T)
      detector.onData('pty-b', 'transforming modules\r\n', T + 1_000)
      detector.onData('pty-b', osc('⠙ npm run build'), T + 2_000)
      detector.onExit('pty-b')
    })
    // No agent ran, so no hook ever fires.
    const canonical = runCanonicalPipeline(() => {})

    expect(title.spawned).toBe(1)
    expect(canonical).toEqual({ spawned: 0, timeMs: 0 })
  })

  it('one agent across a reconnect: the title detector counts 2, the canonical path counts 1', () => {
    // ptyIds are per-spawn UUIDs that are never reused (agent-detector.ts:78), so
    // a reconnect that replays buffered output into a fresh PTY re-runs the whole
    // UNKNOWN -> AGENT first-classification and mints a second spawn. Pane keys are
    // stable across reconnect, and a replayed status is a snapshot, not a transition.
    const title = runTitlePipeline((detector) => {
      detector.onData('pty-c1', `${osc('⠂ Claude Code')}writing patch\r\n`, T)
      detector.onExit('pty-c1')
      // Reconnect: restore replays the buffered scrollback into a new PTY.
      detector.onData('pty-c2', `${osc('⠂ Claude Code')}writing patch\r\n`, T + 60_000)
      detector.onExit('pty-c2')
    })
    const canonical = runCanonicalPipeline((recorder) => {
      recorder.onStatus(hook('pane-c', 'working', T))
      // Reconnect replays the cached status for the pane.
      recorder.onStatus(hook('pane-c', 'working', T, { isReplay: true }))
      recorder.onStatus(hook('pane-c', 'done', T + 60_000, { isReplay: true }))
    })

    expect(title.spawned).toBe(2)
    expect(canonical).toEqual({ spawned: 1, timeMs: 60_000 })
  })

  it('aggregate delta across all three scenarios', () => {
    const titleCollector = new StatsCollector()
    const titleDetector = new AgentDetector(titleCollector)
    const canonicalCollector = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(canonicalCollector)

    // 1. hook-only agent
    titleDetector.onData('pty-a', osc('~/projects/site — bash'), T)
    titleDetector.onExit('pty-a')
    recorder.onStatus(hook('pane-a', 'working', T))
    recorder.onStatus(hook('pane-a', 'done', T + 180_000))

    // 2. braille-spinner non-agent TUI
    titleDetector.onData('pty-b', `${osc('⠋ npm run build')}transforming\r\n`, T)
    titleDetector.onExit('pty-b')

    // 3. one agent, one reconnect
    titleDetector.onData('pty-c1', `${osc('⠂ Claude Code')}writing patch\r\n`, T)
    titleDetector.onExit('pty-c1')
    titleDetector.onData('pty-c2', `${osc('⠂ Claude Code')}writing patch\r\n`, T + 60_000)
    titleDetector.onExit('pty-c2')
    recorder.onStatus(hook('pane-c', 'working', T))
    recorder.onStatus(hook('pane-c', 'working', T, { isReplay: true }))
    recorder.onStatus(hook('pane-c', 'done', T + 60_000, { isReplay: true }))

    expect(totals(titleCollector).spawned).toBe(3)
    expect(totals(canonicalCollector).spawned).toBe(2)
    // The only real agent work in the whole timeline is the two hook sessions.
    expect(totals(canonicalCollector).timeMs).toBe(240_000)
  })
})
