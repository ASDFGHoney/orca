import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeWebRuntimeTerminal,
  consumePendingWebRuntimeSplitMirrorTelemetry,
  isWebRuntimeSessionActive,
  splitWebRuntimeTerminal
} from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  resetWebSessionFocusIntentForTests()
  replaceRuntimeEnvironmentRevisions([])
})

const SPLIT_WT = 'repo::/worktree'

/** Store shape the split focus claim reads to find the worktree owning the host tab. */
function stubSplitSourceTab(hostTabId: string): void {
  mocks.getState.mockReturnValue({
    tabsByWorktree: {
      [SPLIT_WT]: [{ id: toWebTerminalSurfaceTabId(hostTabId), worktreeId: SPLIT_WT }]
    }
  })
}

describe('splitWebRuntimeTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('passes telemetry source to the host split while allowing the mirrored split event to be suppressed', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          paneRuntimeId: -1
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'horizontal', 'keyboard')).toBe(
      true
    )
    expect(
      consumePendingWebRuntimeSplitMirrorTelemetry('remote:web-env-1@@terminal-other', 'horizontal')
    ).toBe(false)
    expect(
      consumePendingWebRuntimeSplitMirrorTelemetry('remote:web-env-1@@terminal-1', 'horizontal')
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'web-env-1',
      method: 'terminal.split',
      params: {
        terminal: 'terminal-1',
        direction: 'horizontal',
        telemetrySource: 'keyboard'
      },
      timeoutMs: 15_000
    })
  })

  it('does not track rejected host split RPCs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: false,
      error: { code: 'terminal_exited', message: 'Terminal exited' }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'context_menu')
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('ignores local panes but delegates remote runtime panes from desktop or web clients', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          ptyId: 'pty-2'
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(splitWebRuntimeTerminal('pty-local-1', 'horizontal', 'keyboard')).toBe(false)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'horizontal', 'keyboard')).toBe(
      true
    )

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
  })

  it('claims the created leaf so the mirrored split arrives focused', async () => {
    stubSplitSourceTab('tab-1')
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          paneRuntimeId: -1,
          leafId: 'leaf-2'
        }
      }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard')).toBe(
      true
    )

    await vi.waitFor(() =>
      expect(peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WT)).toEqual({
        hostTabId: 'tab-1',
        leafId: 'leaf-2'
      })
    )
    // The host can publish the split before the RPC answers, so the intent needs a replay behind it.
    await vi.waitFor(() => expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalled())
  })

  it('fences the host split on the revision the focus claim captured', async () => {
    stubSplitSourceTab('tab-1')
    replaceRuntimeEnvironmentRevisions([{ id: 'web-env-1', createdAt: 7 }])
    let answerSplit!: (response: unknown) => void
    const runtimeCall = vi.fn(
      () =>
        new Promise((resolve) => {
          answerSplit = resolve
        })
    )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard')).toBe(
      true
    )

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.split',
        expectedEnvironmentPairingRevision: 7
      })
    )

    // Why: a same-id re-pair while the split is in flight belongs to a different host, so the
    // claim must not land on the replacement's mirror.
    replaceRuntimeEnvironmentRevisions([{ id: 'web-env-1', createdAt: 9 }])
    answerSplit({
      id: 'split',
      ok: true,
      result: {
        split: { handle: 'terminal-2', tabId: 'tab-1', paneRuntimeId: -1, leafId: 'leaf-2' }
      }
    })

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WT)).toBeNull()
  })

  it('leaves focus alone when the host cannot name the created leaf', async () => {
    stubSplitSourceTab('tab-1')
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          paneRuntimeId: -1
        }
      }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard')).toBe(
      true
    )

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WT)).toBeNull()
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).not.toHaveBeenCalled()
  })
})

describe('closeWebRuntimeTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('delegates remote pane close to the host runtime', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close',
      ok: true,
      result: {
        close: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          ptyKilled: true
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(closeWebRuntimeTerminal('remote:web-env-1@@terminal-1')).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'web-env-1',
      method: 'terminal.close',
      params: {
        terminal: 'terminal-1'
      },
      timeoutMs: 15_000
    })
  })

  it('ignores local panes but delegates remote runtime panes from desktop or web clients', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close',
      ok: true,
      result: {
        close: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          ptyKilled: true
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(closeWebRuntimeTerminal('pty-local-1')).toBe(false)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    expect(closeWebRuntimeTerminal('remote:web-env-1@@terminal-1')).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
  })

  it('treats any configured remote runtime environment as a shared session', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)

    expect(isWebRuntimeSessionActive('env-1')).toBe(true)
    expect(isWebRuntimeSessionActive('   ')).toBe(false)
    expect(isWebRuntimeSessionActive(null)).toBe(false)
  })
})
