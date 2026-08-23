// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { UpdateCard } from './UpdateCard'

const sessionPersistence = vi.fn()

function mockApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: { relaunch: vi.fn() },
      settings: { set: vi.fn().mockResolvedValue(undefined) },
      shell: { openUrl: vi.fn() },
      ui: { set: vi.fn().mockResolvedValue(undefined), writeClipboardText: vi.fn() },
      pty: { management: { sessionPersistence } },
      updater: {
        check: vi.fn(),
        dismissNudge: vi.fn(),
        dismissAvailableUpdate: vi.fn().mockResolvedValue(undefined),
        download: vi.fn(),
        getLinuxPackageInstallInstructions: vi.fn().mockResolvedValue({ ok: false }),
        showLinuxPackage: vi.fn(),
        quitAndInstall: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
}

function renderAvailableUpdate(): void {
  useAppStore.setState({
    updateStatus: { state: 'available', version: '1.4.200', changelog: null },
    updateChangelog: null,
    dismissedUpdateVersion: null,
    updateCardCollapsed: false,
    updateReassuranceSeen: false
  })
  render(<UpdateCard />)
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  sessionPersistence.mockReset()
  mockApi()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('UpdateCard session-preservation promise', () => {
  it('drops the no-interruption promise when terminals run on fallback local PTYs', async () => {
    sessionPersistence.mockResolvedValue({ available: false })
    renderAvailableUpdate()

    await waitFor(() => expect(screen.getAllByText(/may not be preserved/).length).toBe(2))
    expect(screen.queryByText(/won't be interrupted/)).toBeNull()
    expect(
      screen.getByText('Terminal sessions may not be preserved during this update.')
    ).toBeTruthy()
    expect(screen.getByText('Sessions may not be preserved.')).toBeTruthy()
  })

  it('keeps the promise when the daemon owns the sessions', async () => {
    sessionPersistence.mockResolvedValue({ available: true })
    renderAvailableUpdate()

    await waitFor(() => expect(screen.getByText("Sessions won't be interrupted.")).toBeTruthy())
    expect(
      screen.getByText("Your terminal sessions won't be interrupted during the update.")
    ).toBeTruthy()
  })

  it('claims nothing while persistence is still unknown', async () => {
    sessionPersistence.mockReturnValue(new Promise(() => {}))
    renderAvailableUpdate()

    await waitFor(() => expect(screen.getByText('Update Available')).toBeTruthy())
    expect(screen.queryByText(/interrupted/)).toBeNull()
    expect(screen.queryByText(/preserved/)).toBeNull()
  })

  it('claims nothing when the persistence probe fails', async () => {
    sessionPersistence.mockRejectedValue(new Error('ipc unavailable'))
    renderAvailableUpdate()

    await waitFor(() => expect(screen.getByText('Update Available')).toBeTruthy())
    expect(screen.queryByText(/interrupted/)).toBeNull()
    expect(screen.queryByText(/preserved/)).toBeNull()
  })
})
