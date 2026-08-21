import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const reconciliationHookSource = readFileSync(
  new URL('./use-mobile-session-tabs-reconciliation.ts', import.meta.url),
  'utf8'
)
const autoCreateHookSource = readFileSync(
  new URL('./use-initial-session-terminal-autocreate.ts', import.meta.url),
  'utf8'
)

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('mobile session startup', () => {
  it('auto-creates one terminal for an initially empty connected session', () => {
    expect(source).toContain(
      'const initialSessionAutoCreateRef = useRef(createInitialSessionAutoCreateState())'
    )
    expect(source).toContain(
      'initialSessionAutoCreateRef.current = createInitialSessionAutoCreateState()'
    )
    expect(source).toContain('useInitialSessionTerminalAutoCreate({')
    expect(autoCreateHookSource).toContain('stateRef.current.autoCreatedForWorktree = worktreeId')
    expect(autoCreateHookSource).toContain('createTerminal()')
    expect(source).toContain("setCreateError('')")
    expect(source).toContain('void handleCreateTerminal()')
    expect(source).toContain(
      'const hostedAdapterCreate = !client && sessionTabOperations && !options'
    )
    expect(source).toContain('sessionTabOperations.createAgent(worktreeId, agent)')
    expect(source).toContain('sessionTabOperations.createBlank(worktreeId)')
  })

  it('delegates stream ownership while retaining the exact terminal polling cadence', () => {
    expect(source).toContain('useMobileSessionTabsReconciliation<')
    expect(source).toContain('const applicationRevision = ++appliedSessionTabsRevisionRef.current')
    expect(source).toContain('getApplicationRevision: getSessionTabsApplicationRevision')
    expect(source).toContain('sessionTabOperations,')
    expect(source).not.toContain("client.subscribe(\n      'session.tabs.subscribe'")
    expect(reconciliationHookSource).toContain(
      "directClient.subscribe(\n      'session.tabs.subscribe'"
    )
    expect(reconciliationHookSource).toContain('sessionTabOperations.snapshot(worktreeId)')
    expect(reconciliationHookSource).toContain('sessionTabOperations.subscribe(')
    expect(reconciliationHookSource).toContain(
      "if (AppState.currentState !== 'active') {\n          controller.setReconciliationActive(false)"
    )
    expect(reconciliationHookSource).toContain('void controller.poll()')
    expect(reconciliationHookSource).toContain('void fetchTerminals()')
    expect(reconciliationHookSource).toContain("AppState.addEventListener('change'")
    expect(reconciliationHookSource).toContain('const interval = setInterval(')
    expect(reconciliationHookSource).toContain('2000')
    expect(reconciliationHookSource).toContain('controller.setReconciliationActive(false)')
    expect(reconciliationHookSource).toContain('clearInterval(interval)')
    expect(reconciliationHookSource).toContain('appStateSubscription.remove()')
  })

  it('loads session tabs without waiting for desktop activation', () => {
    const startupEffect = sliceBetween(
      'void (async () => {',
      'return () => {\n      disposed = true'
    )

    expect(startupEffect).toContain("void client\n          .sendRequest('worktree.activate'")
    expect(startupEffect).toContain("if (client && created !== '1' && !isFloatingWorkspaceRoute)")
    expect(startupEffect).toContain("if (client && created === '1' && !isFloatingWorkspaceRoute)")
    expect(startupEffect).toContain('notifyClients: false')
    expect(startupEffect).toContain("navigation: 'caller'")
    expect(startupEffect).not.toContain("await client\n          .sendRequest('worktree.activate'")
    expect(startupEffect.indexOf("sendRequest('worktree.activate'")).toBeLessThan(
      startupEffect.indexOf('await ensureSessionTabs()')
    )
    expect(startupEffect).toContain('headlessActivationNeedsHostRenderer(response.result)')
    expect(startupEffect).toContain("showToast('Open Orca on the host to wake sleeping agents.'")
  })

  it('fails runtime capability gates closed while probing a replacement client', () => {
    const capabilityEffect = sliceBetween(
      'const [runtimeCapabilitySnapshot, setRuntimeCapabilitySnapshot]',
      '// Why: read deviceToken from host record'
    )
    const probeStart = capabilityEffect.indexOf('startRuntimeCapabilityRead(')

    expect(probeStart).toBeGreaterThanOrEqual(0)
    expect(capabilityEffect).toContain('sessionTabOperations.runtimeCapabilities()')
    expect(capabilityEffect).toContain(
      "connState === 'connected' && runtimeCapabilitySnapshot?.operations === sessionTabOperations"
    )
    expect(capabilityEffect).toContain('setRuntimeCapabilitySnapshot({')
    const resetIndex = capabilityEffect.lastIndexOf(
      'hostQueryReplyInputSupportedRef.current = false'
    )
    expect(resetIndex).toBeGreaterThanOrEqual(0)
    expect(resetIndex).toBeLessThan(probeStart)
  })

  it('activates an already-selected pending terminal tab after hydration', () => {
    expect(source).toContain(
      'const pendingTerminalActivationAttemptRef = useRef<string | null>(null)'
    )
    expect(source).toContain('pendingTerminalActivationAttemptRef.current = null')

    const pendingActivationEffect = sliceBetween(
      "if (!sessionTabOperations || connState !== 'connected' || !activePendingTerminalTab) {",
      'const showLoadingState ='
    )
    expect(pendingActivationEffect).toContain(
      'pendingTerminalActivationAttemptRef.current === activationKey'
    )
    expect(pendingActivationEffect).toContain(
      'activateSessionTab(activePendingTerminalTab.id, activePendingTerminalTab.leafId)'
    )
    expect(pendingActivationEffect).toContain('scheduleDelayedAction(() => void fetchSessionTabs()')
  })

  it('keeps ready terminal taps local while publishing caller selection', () => {
    const readyTerminalSwitch = sliceBetween(
      'const switchTab = useCallback(',
      'const switchSessionTab = useCallback('
    )

    expect(readyTerminalSwitch).not.toContain('focusMobileTerminal(client, handle)')
    expect(readyTerminalSwitch).toContain('activateSessionTab(matchingTab.id)')
  })

  it('opens the unchanged setup sheet for synchronous dictation setup failures', () => {
    const startDictation = sliceBetween(
      'const startDictation = useCallback(',
      'const cancelDictation = useCallback('
    )

    expect(startDictation).toContain('isDictationSetupRequiredError(message)')
    expect(startDictation).toContain('setShowDictationSetup(true)')
  })

  it('routes every session-tab activation through the named platform boundary', () => {
    expect(source.match(/activateSessionTab\(/g)).toHaveLength(4)
    expect(source).not.toContain("sendRequest('session.tabs.activate'")
  })

  it('keeps dynamic agent rows above fixed New Tab actions', () => {
    const newTabActions = sliceBetween('title="New Tab"', 'onClose={() => setShowCreateTabDrawer')

    expect(newTabActions.indexOf('...createTabAgentActions')).toBeLessThan(
      newTabActions.indexOf("label: 'Terminal'")
    )
    expect(newTabActions.indexOf("label: 'Terminal'")).toBeLessThan(
      newTabActions.indexOf("label: 'Browser'")
    )
    expect(newTabActions.indexOf("label: 'Browser'")).toBeLessThan(
      newTabActions.indexOf("label: 'Markdown Note'")
    )
    expect(newTabActions).toContain("label: 'Browser',\n                  closeBeforePress: true")
  })

  it('wires pending-handle recovery through its bounded context (STA-4256)', () => {
    const applySessionTabs = sliceBetween(
      'const applySessionTabs = useCallback(',
      'const consumeAcceptedSessionTabs = useCallback('
    )
    const recoveryContext = sliceBetween(
      'const pendingTerminalRecoveryContextCache = useMemo(',
      'const getSessionTabsApplicationRevision'
    )

    const tabsRefWrite = 'sessionTabsRef.current = nextTabs'
    const tabsStateWrite = 'setSessionTabs((prev)'
    const activeRefWrite = 'activeSessionTabIdRef.current = active?.id ?? null'
    const activeStateWrite = 'setActiveSessionTabId(active?.id ?? null)'
    for (const write of [tabsRefWrite, tabsStateWrite, activeRefWrite, activeStateWrite]) {
      expect(applySessionTabs).toContain(write)
    }
    expect(applySessionTabs.indexOf(tabsRefWrite)).toBeLessThan(
      applySessionTabs.indexOf(tabsStateWrite)
    )
    expect(applySessionTabs.indexOf(activeRefWrite)).toBeLessThan(
      applySessionTabs.indexOf(activeStateWrite)
    )
    expect(recoveryContext).toContain('() => new PendingTerminalHandleRecoveryContextCache()')
    expect(recoveryContext).toContain('sessionTabsRef.current,')
    expect(recoveryContext).toContain('activeSessionTabIdRef.current')
    expect(recoveryContext).toContain(
      'const pendingTerminalRecoveryContextKey = getPendingTerminalRecoveryContextKey()'
    )
    expect(source).toContain('hasRecoveryNeed: hasSessionTabsRecoveryNeed')
    expect(source).toContain('getPendingTerminalRecoveryContextKey,')
    expect(source).toContain('onPendingTerminalRecoveryParked: setParkedPendingTerminalContext')
    expect(source).toContain('retryPendingTerminalRecovery()')
  })
})
