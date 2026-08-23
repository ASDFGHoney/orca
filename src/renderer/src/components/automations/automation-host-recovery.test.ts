import { describe, expect, it, vi } from 'vitest'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import {
  runAutomationHostRecovery,
  type AutomationHostRecoveryDeps
} from './automation-host-recovery'

function entry(
  overrides: Partial<AutomationHostCatalogEntry> & Pick<AutomationHostCatalogEntry, 'stableRef'>
): AutomationHostCatalogEntry {
  return {
    owner: null,
    stableKey: 'host',
    label: 'Host',
    authorityLabel: 'Authority',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function deps() {
  return {
    retry: vi.fn<AutomationHostRecoveryDeps['retry']>(),
    connectSshTarget: vi.fn<AutomationHostRecoveryDeps['connectSshTarget']>(),
    connectRuntimeEnvironment: vi.fn<AutomationHostRecoveryDeps['connectRuntimeEnvironment']>(),
    openSettings: vi.fn<AutomationHostRecoveryDeps['openSettings']>()
  }
}

const DESKTOP_SSH = entry({
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } },
  kind: 'ssh'
})
const RUNTIME_SSH = entry({
  stableRef: {
    authority: { kind: 'runtime', environmentId: 'gpu' },
    selector: { kind: 'ssh', targetId: 't1' }
  },
  kind: 'ssh'
})

describe('automation host recovery', () => {
  it('retries the host rather than the whole page', async () => {
    const target = deps()
    await runAutomationHostRecovery('retry', DESKTOP_SSH, target)
    expect(target.retry).toHaveBeenCalledWith(DESKTOP_SSH)
  })

  it('dials the SSH target when the authority is fine', async () => {
    const target = deps()
    await runAutomationHostRecovery('reconnect', DESKTOP_SSH, target)
    expect(target.connectSshTarget).toHaveBeenCalledWith('t1', undefined)
    expect(target.connectRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('dials a reachable runtime SSH target on that server, not the local SSH API', async () => {
    const target = deps()
    await runAutomationHostRecovery('reconnect', RUNTIME_SSH, target)
    expect(target.connectSshTarget).toHaveBeenCalledWith('t1', 'gpu')
    expect(target.connectRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('dials the runtime first when the server itself is unreachable', async () => {
    const target = deps()
    // Why: an unreachable server cannot be asked to dial its own SSH target.
    await runAutomationHostRecovery(
      'reconnect',
      { ...RUNTIME_SSH, authorityHealth: 'unavailable' },
      target
    )
    expect(target.connectRuntimeEnvironment).toHaveBeenCalledWith('gpu')
    expect(target.connectSshTarget).not.toHaveBeenCalled()
  })

  it('re-asks a desktop Self host, which has no transport to dial', async () => {
    const target = deps()
    const desktopSelf = entry({
      stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
    })
    await runAutomationHostRecovery('reconnect', desktopSelf, target)
    expect(target.retry).toHaveBeenCalledWith(desktopSelf)
  })

  it('sends a runtime to the servers pane, since nothing here updates a host', async () => {
    const target = deps()
    await runAutomationHostRecovery('update-server', RUNTIME_SSH, target)
    expect(target.openSettings).toHaveBeenCalledWith({ pane: 'servers', repoId: null })
  })

  it('sends a stale desktop SSH registration to the SSH pane instead', async () => {
    const target = deps()
    await runAutomationHostRecovery('update-server', DESKTOP_SSH, target)
    expect(target.openSettings).toHaveBeenCalledWith({ pane: 'ssh', repoId: null })
  })

  it('does nothing without an entry to act on', async () => {
    const target = deps()
    await runAutomationHostRecovery('retry', null, target)
    expect(target.retry).not.toHaveBeenCalled()
  })
})
