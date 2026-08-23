// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'

const mocks = vi.hoisted(() => ({
  connectRuntimeEnvironmentAndRecordStatus: vi.fn(),
  hydrateRuntimeEnvironmentSshState: vi.fn(),
  connectRuntimeEnvironmentSshTarget: vi.fn(),
  resyncRuntimeEnvironmentSshTargets: vi.fn(),
  toastError: vi.fn(),
  setSshConnectionState: vi.fn(),
  setSshTargetsMetadata: vi.fn(),
  setRemovedSshTargetLabels: vi.fn()
}))

vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeEnvironmentAndRecordStatus: (...args: unknown[]) =>
    mocks.connectRuntimeEnvironmentAndRecordStatus(...args)
}))

vi.mock('@/runtime/runtime-environment-ssh-state', () => ({
  connectRuntimeEnvironmentSshTarget: (...args: unknown[]) =>
    mocks.connectRuntimeEnvironmentSshTarget(...args),
  hydrateRuntimeEnvironmentSshState: (...args: unknown[]) =>
    mocks.hydrateRuntimeEnvironmentSshState(...args),
  resyncRuntimeEnvironmentSshTargets: (...args: unknown[]) =>
    mocks.resyncRuntimeEnvironmentSshTargets(...args)
}))

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setSshConnectionState: mocks.setSshConnectionState,
      setSshTargetsMetadata: mocks.setSshTargetsMetadata,
      setRemovedSshTargetLabels: mocks.setRemovedSshTargetLabels
    })
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  connectAutomationHostRuntime,
  connectAutomationHostSshTarget
} from './automation-host-recovery-connect'

function installSshApi(connect: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ssh: {
        connect,
        listTargets: vi.fn().mockResolvedValue([]),
        listRemovedTargetLabels: vi.fn().mockResolvedValue({})
      }
    }
  })
}

describe('automation host recovery connect', () => {
  beforeEach(() => {
    resetSshConnectInFlightForTests()
    for (const fn of Object.values(mocks)) {
      fn.mockReset()
    }
    mocks.hydrateRuntimeEnvironmentSshState.mockResolvedValue(undefined)
    mocks.connectRuntimeEnvironmentSshTarget.mockResolvedValue({ status: 'connected' })
    mocks.resyncRuntimeEnvironmentSshTargets.mockResolvedValue(undefined)
    installSshApi(vi.fn().mockResolvedValue({ status: 'connected' }))
  })

  afterEach(() => {
    resetSshConnectInFlightForTests()
  })

  it('records runtime status so the catalog can leave Unreachable', async () => {
    mocks.connectRuntimeEnvironmentAndRecordStatus.mockResolvedValue(true)

    await connectAutomationHostRuntime('gpu')

    expect(mocks.connectRuntimeEnvironmentAndRecordStatus).toHaveBeenCalledWith('gpu', 15_000)
    expect(mocks.hydrateRuntimeEnvironmentSshState).toHaveBeenCalledWith('gpu')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('toasts when the runtime stays unreachable', async () => {
    mocks.connectRuntimeEnvironmentAndRecordStatus.mockResolvedValue(false)

    await connectAutomationHostRuntime('gpu')

    expect(mocks.toastError).toHaveBeenCalledWith('Remote host is not reachable')
    expect(mocks.hydrateRuntimeEnvironmentSshState).not.toHaveBeenCalled()
  })

  it('writes the local SSH connect result into the store the catalog reads', async () => {
    const connect = vi.fn().mockResolvedValue({ status: 'connected', targetId: 't1' })
    installSshApi(connect)

    await connectAutomationHostSshTarget({ targetId: 't1' })

    expect(connect).toHaveBeenCalledWith({ targetId: 't1' })
    expect(mocks.setSshConnectionState).toHaveBeenCalledWith('t1', {
      status: 'connected',
      targetId: 't1'
    })
    expect(mocks.connectRuntimeEnvironmentSshTarget).not.toHaveBeenCalled()
  })

  it('dials a runtime SSH target through that server, not the local SSH API', async () => {
    const connect = vi.fn()
    installSshApi(connect)

    await connectAutomationHostSshTarget({ targetId: 't1', environmentId: 'gpu' })

    expect(mocks.connectRuntimeEnvironmentSshTarget).toHaveBeenCalledWith('gpu', 't1')
    expect(connect).not.toHaveBeenCalled()
  })

  it('toasts a failed local SSH connect instead of swallowing it', async () => {
    installSshApi(vi.fn().mockRejectedValue(new Error('SSH target "t1" not found')))

    await connectAutomationHostSshTarget({ targetId: 't1' })

    expect(mocks.toastError).toHaveBeenCalledWith('SSH target "t1" not found')
  })
})
