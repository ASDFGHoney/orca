import { describe, expect, it, vi } from 'vitest'
import {
  runShutdownCheckpointPersist,
  type ShutdownCheckpointPersistDeps
} from './shutdown-checkpoint-persist'

function makeDeps(
  overrides: Partial<ShutdownCheckpointPersistDeps> = {}
): ShutdownCheckpointPersistDeps {
  return {
    shouldCaptureSession: () => true,
    captureTerminalBuffers: vi.fn(),
    captureSleepingAgentSessions: vi.fn(),
    buildSessionSnapshots: () => [{ state: { activeTabId: 't1' } }] as never,
    buildUiPatch: () => ({ activeView: 'workspace' }) as never,
    hasDirtyOpenFiles: () => false,
    isDegradableShutdownInProgress: () => true,
    stageBeforeUnloadSync: vi.fn(),
    ...overrides
  }
}

describe('runShutdownCheckpointPersist', () => {
  it('does not fail the checkpoint when the sleeping-agent quit capture throws (STA-5505)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      captureSleepingAgentSessions: () => {
        throw new Error('capture exploded')
      }
    })

    expect(() => runShutdownCheckpointPersist(deps)).not.toThrow()
    // The full snapshot must still be staged — losing at most one minute of
    // resume records is strictly better than blocking the update.
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledWith({
      sessions: [{ state: { activeTabId: 't1' } }],
      ui: { activeView: 'workspace' }
    })
    vi.restoreAllMocks()
  })

  it('degrades to durable-only staging when full staging throws during an intentional restart (STA-5505)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stageBeforeUnloadSync = vi.fn((args: { sessions: unknown[] }) => {
      if (args.sessions.length > 0) {
        throw new Error('sync IPC staging failed')
      }
    })
    const deps = makeDeps({ stageBeforeUnloadSync })

    expect(() => runShutdownCheckpointPersist(deps)).not.toThrow()
    expect(stageBeforeUnloadSync).toHaveBeenCalledTimes(2)
    expect(stageBeforeUnloadSync).toHaveBeenLastCalledWith({
      sessions: [],
      ui: { activeView: 'workspace' }
    })
    vi.restoreAllMocks()
  })

  it('still fails the checkpoint when staging throws and dirty editor buffers exist', () => {
    const deps = makeDeps({
      hasDirtyOpenFiles: () => true,
      stageBeforeUnloadSync: vi.fn(() => {
        throw new Error('sync IPC staging failed')
      })
    })

    expect(() => runShutdownCheckpointPersist(deps)).toThrow('sync IPC staging failed')
  })

  it('still fails the checkpoint when staging throws outside a degradable shutdown', () => {
    const deps = makeDeps({
      isDegradableShutdownInProgress: () => false,
      stageBeforeUnloadSync: vi.fn(() => {
        throw new Error('sync IPC staging failed')
      })
    })

    expect(() => runShutdownCheckpointPersist(deps)).toThrow('sync IPC staging failed')
  })

  it('fails the checkpoint when even durable-only staging throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      buildSessionSnapshots: () => {
        throw new Error('snapshot build failed')
      },
      stageBeforeUnloadSync: vi.fn(() => {
        throw new Error('durable staging failed')
      })
    })

    expect(() => runShutdownCheckpointPersist(deps)).toThrow('durable staging failed')
    vi.restoreAllMocks()
  })

  it('keeps the durable-session fallback for snapshot build failures', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({
      buildSessionSnapshots: () => {
        throw new Error('snapshot build failed')
      }
    })

    expect(() => runShutdownCheckpointPersist(deps)).not.toThrow()
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledTimes(1)
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledWith({
      sessions: [],
      ui: { activeView: 'workspace' }
    })
    vi.restoreAllMocks()
  })

  it('rethrows snapshot build failures when dirty editor buffers exist', () => {
    const deps = makeDeps({
      hasDirtyOpenFiles: () => true,
      buildSessionSnapshots: () => {
        throw new Error('snapshot build failed')
      }
    })

    expect(() => runShutdownCheckpointPersist(deps)).toThrow('snapshot build failed')
    expect(deps.stageBeforeUnloadSync).not.toHaveBeenCalled()
  })

  it('skips capture and stages empty sessions before hydration completes', () => {
    const deps = makeDeps({ shouldCaptureSession: () => false })

    runShutdownCheckpointPersist(deps)

    expect(deps.captureTerminalBuffers).not.toHaveBeenCalled()
    expect(deps.captureSleepingAgentSessions).not.toHaveBeenCalled()
    expect(deps.stageBeforeUnloadSync).toHaveBeenCalledWith({
      sessions: [],
      ui: { activeView: 'workspace' }
    })
  })
})
