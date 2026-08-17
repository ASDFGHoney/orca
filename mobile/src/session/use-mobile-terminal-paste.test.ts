import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '../../../src/shared/terminal-bracketed-paste-text'
import { useMobileTerminalPaste } from './use-mobile-terminal-paste'

const clipboardMocks = vi.hoisted(() => ({
  getImageAsync: vi.fn(),
  getStringAsync: vi.fn()
}))

vi.mock('expo-clipboard', () => clipboardMocks)
vi.mock('expo-file-system', () => ({
  File: class {},
  Paths: { cache: '/cache' }
}))
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: vi.fn() },
  SaveFormat: { PNG: 'png' }
}))

const MODES: TerminalModes = {
  bracketedPasteMode: true,
  altScreen: true,
  mouseTrackingMode: 'none',
  sgrMouseMode: false,
  sgrMousePixelsMode: false
}

describe('useMobileTerminalPaste', () => {
  let renderer: ReactTestRenderer | null = null
  let paste: (() => Promise<void>) | null = null
  let sendRequest = vi.fn()
  let flushPendingInput = vi.fn()
  let onError = vi.fn()
  let onSuccess = vi.fn()
  let showToast = vi.fn()
  let modes = new Map<string, TerminalModes>()

  beforeEach(() => {
    sendRequest = vi.fn().mockResolvedValue({})
    flushPendingInput = vi.fn().mockResolvedValue(true)
    onError = vi.fn()
    onSuccess = vi.fn()
    showToast = vi.fn()
    modes = new Map([['terminal', MODES]])
    clipboardMocks.getStringAsync.mockReset()
    clipboardMocks.getImageAsync.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    paste = null
  })

  function Harness(): null {
    const client = { sendRequest } as unknown as RpcClient
    paste = useMobileTerminalPaste({
      activeHandle: 'terminal',
      activeHandleRef: { current: 'terminal' },
      activeSessionTabTypeRef: { current: 'terminal' },
      canSend: true,
      client,
      clientRef: { current: client },
      connState: 'connected',
      connStateRef: { current: 'connected' },
      deviceTokenRef: { current: 'device' },
      flushPendingLiveInputBeforeExternalSend: flushPendingInput,
      getActiveWorktreeConnectionId: vi.fn().mockResolvedValue(null),
      onError,
      onSuccess,
      ptyModesRef: { current: modes },
      refreshCanPaste: vi.fn(),
      showToast
    })
    return null
  }

  async function mountAndPaste(text: string): Promise<void> {
    clipboardMocks.getStringAsync.mockResolvedValue(text)
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await paste?.()
    })
  }

  it('sends one bracketed frame when the live mode is on in an alt-screen TUI', async () => {
    await mountAndPaste('line one\nline two')

    expect(flushPendingInput).toHaveBeenCalledWith('terminal')
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'terminal',
      text: `${BRACKETED_PASTE_START}line one\rline two${BRACKETED_PASTE_END}`,
      enter: false,
      client: { id: 'device', type: 'mobile' }
    })
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('preserves fail-open unframed behavior when bracketed paste mode is off', async () => {
    modes.set('terminal', { ...MODES, bracketedPasteMode: false })

    await mountAndPaste('line one\nline two')

    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'line one\nline two' })
    )
  })

  it('enforces the 256 KiB cap on the final framed payload', async () => {
    const cap = 256 * 1024
    const frameBytes = BRACKETED_PASTE_START.length + BRACKETED_PASTE_END.length

    await mountAndPaste('x'.repeat(cap - frameBytes))
    expect(sendRequest).toHaveBeenCalledOnce()

    act(() => renderer?.unmount())
    renderer = null
    paste = null
    sendRequest.mockClear()
    await mountAndPaste('x'.repeat(cap - frameBytes + 1))

    expect(sendRequest).not.toHaveBeenCalled()
    expect(flushPendingInput).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith('Paste too large (max 256 KiB)', 1500)
  })
})
