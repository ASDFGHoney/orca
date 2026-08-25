// @vitest-environment happy-dom

/**
 * The probe seeds every row with `status: 'loading'` and only the probe's own continuation clears it.
 * A #185 escalation returns from that continuation, so without a compensating write the row spins
 * "Checking…" for the rest of the session — asserting a probe that is not running.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'
import { TooltipProvider } from '../ui/tooltip'
import { clearReactErrorBoundaryReportingForTest } from '@/lib/react-error-boundary-reporting'
import {
  flushReactUpdateDepthEscalationsForTest,
  resetReactUpdateDepthEscalationForTest
} from '@/lib/react-update-depth-escalation'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/protocol-version'

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

const setRuntimeEnvironments = vi.fn()
const setRuntimeEnvironmentStatus = vi.fn()

const mockStoreState = {
  remoteServerUpdates: new Map(),
  remoteServerUpdatesChecking: false,
  remoteServerUpdatesRunning: false,
  refreshRemoteServerUpdates: vi.fn(),
  setRemoteServerUpdateDialogOpen: vi.fn(),
  setRuntimeEnvironments,
  setRuntimeEnvironmentStatus,
  settingsSearchQuery: '',
  activeView: 'settings',
  activeModal: 'settings',
  activeTabType: null,
  rightSidebarTab: null,
  activeWorktreeId: null
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
}))

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

const recordRendererError = vi.fn()
const list = vi.fn()
const getStatus = vi.fn()
const roots: Root[] = []

const ENVIRONMENT = {
  id: 'env-1',
  name: 'build-box',
  source: 'pairing',
  createdAt: 0,
  lastSeenAt: 0,
  preferredEndpointId: 'ep-1',
  endpoints: [{ id: 'ep-1', kind: 'direct', url: 'https://build-box.example' }]
}

const RUNTIME_STATUS = {
  ok: true,
  version: '1.4.163',
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleMobileVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION,
  capabilities: []
}

const SETTINGS = { activeRuntimeEnvironmentId: null } as unknown as GlobalSettings

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  recordRendererError.mockReset()
  recordRendererError.mockResolvedValue({ ok: true, report: null, deduped: false })
  list.mockReset()
  list.mockResolvedValue([ENVIRONMENT])
  getStatus.mockReset()
  getStatus.mockResolvedValue({ ok: true, result: RUNTIME_STATUS })
  toastError.mockReset()
  setRuntimeEnvironments.mockReset()
  setRuntimeEnvironmentStatus.mockReset()
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  Object.assign(globalThis.window, {
    api: {
      runtimeEnvironments: { list, getStatus },
      crashReports: { recordRendererError }
    }
  })
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
})

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <RuntimeEnvironmentsPane
          settings={SETTINGS}
          setActiveRuntimeEnvironmentPreference={vi.fn().mockResolvedValue(true)}
        />
      </TooltipProvider>
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

describe('RuntimeEnvironmentsPane host probe', () => {
  it('settles the row when a #185 escalation aborts the probe continuation', async () => {
    setRuntimeEnvironmentStatus.mockImplementation(() => {
      throw new Error(REACT_185)
    })

    const container = await render()
    await flushReactUpdateDepthEscalationsForTest()

    expect(recordRendererError).toHaveBeenCalledTimes(1)
    expect(recordRendererError.mock.calls[0]?.[0]?.boundaryId).toContain('RuntimeEnvironmentsPane')
    expect(container.textContent).not.toContain('Minified React error #185')
    // No probe is running, so the row must not keep claiming one.
    const row = container.querySelector('[data-settings-section="env-1"]')
    expect(row?.textContent).not.toContain('Checking…')
    expect(row?.querySelector('.animate-spin')).toBeNull()
    // The probe itself answered before the loop threw, so its verdict survives.
    expect(row?.textContent).toContain('Compatible')
  })

  it('settles the row on "Status unavailable" when the loop throws before the probe answers', async () => {
    getStatus.mockImplementation(async () => {
      throw new Error(REACT_185)
    })

    const container = await render()
    await flushReactUpdateDepthEscalationsForTest()

    expect(recordRendererError).toHaveBeenCalledTimes(1)
    const row = container.querySelector('[data-settings-section="env-1"]')
    expect(row?.textContent).not.toContain('Checking…')
    expect(row?.querySelector('.animate-spin')).toBeNull()
    expect(row?.textContent).toContain('Status unavailable')
    // A local render loop is no evidence about the host, so the sidebar registry is left alone.
    expect(setRuntimeEnvironmentStatus).not.toHaveBeenCalled()
  })

  it('escalates a #185 from the list catch instead of toasting the digest', async () => {
    setRuntimeEnvironments.mockImplementation(() => {
      throw new Error(REACT_185)
    })

    await render()
    await flushReactUpdateDepthEscalationsForTest()

    expect(recordRendererError).toHaveBeenCalledTimes(1)
    expect(recordRendererError.mock.calls[0]?.[0]?.boundaryId).toContain('loadEnvironments')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('leaves an ordinary probe failure on its host-blaming error path', async () => {
    getStatus.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.4:443'))

    const container = await render()
    await flushReactUpdateDepthEscalationsForTest()

    expect(recordRendererError).not.toHaveBeenCalled()
    expect(setRuntimeEnvironmentStatus).toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({ status: null })
    )
    expect(container.textContent).toContain('connect ETIMEDOUT 10.0.0.4:443')
  })
})
