import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock } = vi.hoisted(() => ({ showMessageBoxMock: vi.fn() }))

vi.mock('electron', () => ({ dialog: { showMessageBox: showMessageBoxMock } }))

import {
  buildUnresponsiveWindowClosePromptOptions,
  promptForUnresponsiveWindowClose
} from './unresponsive-window-close-prompt'

describe('unresponsive-window-close-prompt', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset()
  })

  // Why (#5787): a reflexive Enter or Escape must never be the answer that discards sessions.
  it('makes Wait both the default and the cancel button', () => {
    const options = buildUnresponsiveWindowClosePromptOptions()

    expect(options.buttons?.[0]).toBe('Wait')
    expect(options.buttons?.[1]).toBe('Close Window')
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
  })

  it('spells out what closing costs so the choice is informed', () => {
    expect(buildUnresponsiveWindowClosePromptOptions().detail).toContain('unsaved')
  })

  it('reports close only for the explicit Close Window button', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })

    await expect(promptForUnresponsiveWindowClose()).resolves.toBe('close')
  })

  it('reports wait for every other response', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })

    await expect(promptForUnresponsiveWindowClose()).resolves.toBe('wait')
  })

  it('parents the dialog to the window when one is given', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    const parentWindow = {} as never

    await promptForUnresponsiveWindowClose(parentWindow)

    expect(showMessageBoxMock).toHaveBeenCalledWith(parentWindow, expect.objectContaining({}))
  })

  // Why: a dismissed/failed dialog resolving to nothing must fall back to keeping the window, not closing it.
  it('falls back to wait when the dialog resolves without a response', async () => {
    showMessageBoxMock.mockResolvedValue(undefined)

    await expect(promptForUnresponsiveWindowClose()).resolves.toBe('wait')
  })
})
