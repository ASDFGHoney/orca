// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { CliSection } from './CliSection'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  dialog: { onInstall: null as null | (() => Promise<void>) }
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: () => ({
    installed: false,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: () => <div data-testid="agent-skill-setup-panel" />
}))

// Capture the dialog's install callback so the test can trigger the install
// flow without driving the Radix dialog portal.
vi.mock('./CliRegistrationDialog', () => ({
  CliRegistrationDialog: (props: { onInstall: () => Promise<void> }) => {
    mocks.dialog.onInstall = props.onInstall
    return null
  }
}))

vi.mock('./WslCliRegistration', () => ({
  WslCliRegistration: () => null
}))

const NOT_INSTALLED_STATUS: CliInstallStatus = {
  platform: 'darwin',
  commandName: 'orca',
  commandPath: '/usr/local/bin/orca',
  pathDirectory: '/usr/local/bin',
  pathConfigured: false,
  launcherPath: '/Applications/Orca.app/Contents/Resources/bin/orca',
  installMethod: 'symlink',
  supported: true,
  state: 'not_installed',
  currentTarget: null,
  unsupportedReason: null,
  detail: 'Register /usr/local/bin/orca to use Orca from the terminal.'
}

let root: Root | null = null
let container: HTMLDivElement | null = null
const getInstallStatus = vi.fn()
const install = vi.fn()

async function renderSection(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<CliSection currentPlatform="darwin" settings={getDefaultSettings('/tmp')} />)
  })
  await act(async () => {})
}

describe('CliSection persistent install error', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.dialog.onInstall = null
    getInstallStatus.mockReset()
    install.mockReset()
    getInstallStatus.mockResolvedValue(NOT_INSTALLED_STATUS)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: { getInstallStatus, install, remove: vi.fn() },
        shell: { openPath: vi.fn() }
      }
    })
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    container?.remove()
    root = null
    container = null
  })

  it('persists a failed install reason inline and clears it on a successful refresh', async () => {
    install.mockRejectedValueOnce(
      new Error('Directory /usr/local/bin does not exist on this system')
    )
    await renderSection()

    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})

    const alert = container?.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Directory /usr/local/bin does not exist on this system')
    expect(alert?.className).toContain('text-destructive')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Directory /usr/local/bin does not exist on this system'
    )

    // Refreshing status clears the stale failure so it does not linger forever.
    const refreshButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.getAttribute('aria-label') === 'Refresh CLI status'
    )
    expect(refreshButton).toBeDefined()
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(container?.querySelector('[role="alert"]')).toBeNull()
  })

  it('clears a persisted install error after a later install succeeds', async () => {
    install
      .mockRejectedValueOnce(new Error('Failed to create /usr/local/bin'))
      .mockResolvedValueOnce({
        ...NOT_INSTALLED_STATUS,
        state: 'installed',
        pathConfigured: true,
        detail: 'Registered /usr/local/bin/orca.'
      })
    await renderSection()

    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Failed to create /usr/local/bin'
    )

    // A subsequent successful install must clear the stale failure, so the user
    // can tell "install failed" apart from "now installed".
    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})

    expect(container?.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
  })
})
