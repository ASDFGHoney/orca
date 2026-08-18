// @vitest-environment happy-dom
/**
 * iPadOS Hangul with a hardware keyboard fires no composition events at all (#13345). Captured on
 * the device, `한글` is six plain keydowns whose `key` is the jamo, each followed by the IME
 * rewriting the composing syllable in place in the helper textarea:
 *
 *   keydown 'ㅎ' → insertText 'ㅎ'                       value 'ㅎ'
 *   keydown 'ㅏ' → deleteContentBackward, insertText '하' value '하'
 *   keydown 'ㄴ' → deleteContentBackward, insertText '한' value '한'
 *   keydown 'ㄱ' → insertText 'ㄱ'                       value '한ㄱ'
 *
 * Unpatched xterm sends the jamo from `_keyPress` and drops the composed syllable, because
 * `_inputEvent` admits a composed `insertText` only when no key is down — and one is down for every
 * one of them. The pty sees `ㅎㅏㄴㄱㅡㄹ`.
 *
 * A jamo keydown is therefore held as a preedit instead of forwarded, and the textarea is read back
 * to decide what to commit: the IME replaces the syllable it is still building and appends once
 * that syllable is final, so a tail that grew past what was held is what releases it. The pty sees
 * one commit per syllable and no intermediate state — never the send-then-backspace stream a
 * naive textarea diff produces, which a full-screen TUI would have to undo.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const IPAD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

type Rig = {
  compositionView: HTMLElement
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
}

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

/** iPadOS reports a Mac user agent, so the touch-point count is what separates it from a desktop. */
function pretendTouchIOS(maxTouchPoints = 5, userAgent = IPAD_USER_AGENT): void {
  Object.defineProperty(navigator, 'userAgent', {
    value: userAgent,
    configurable: true
  })
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: maxTouchPoints,
    configurable: true
  })
}

function openTerminal(options: { screenReaderMode?: boolean } = {}): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 40, rows: 8, ...options })
  terminal.open(container)
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !compositionView) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }
  openTerminals.push(terminal)
  const cell = (
    terminal as unknown as {
      _core: {
        _renderService: {
          dimensions: { css: { cell: { height: number; width: number } } }
        }
      }
    }
  )._core._renderService.dimensions.css.cell
  cell.width = 8
  cell.height = 16
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { compositionView, emitted, terminal, textarea }
}

/** @returns Whether the key was consumed, which in a real browser suppresses everything after it. */
function dispatchKey(
  { textarea }: Rig,
  type: 'keydown' | 'keypress' | 'keyup',
  init: { key: string; code?: string; keyCode?: number; charCode?: number }
): boolean {
  const event = new KeyboardEvent(type, {
    key: init.key,
    code: init.code ?? 'KeyQ',
    bubbles: true,
    cancelable: true
  })
  // happy-dom drops the legacy numeric fields from KeyboardEventInit; xterm's key paths read them.
  Object.defineProperty(event, 'keyCode', {
    value: init.keyCode ?? init.key.charCodeAt(0)
  })
  Object.defineProperty(event, 'charCode', { value: init.charCode ?? 0 })
  textarea.dispatchEvent(event)
  return event.defaultPrevented
}

function dispatchInput({ textarea }: Rig, inputType: string, data: string | null): void {
  const event = new InputEvent('input', { bubbles: true })
  Object.defineProperty(event, 'inputType', { value: inputType })
  Object.defineProperty(event, 'data', { value: data })
  // Trusted user events are always composed; that is the flag that makes xterm drop the commit.
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

/**
 * One printable keystroke as a browser produces it: the key, then — only if xterm did not consume
 * the keydown — the keypress and the text the IME writes into the textarea.
 */
async function typePrintable(
  rig: Rig,
  {
    key,
    keyCode,
    written,
    replaces
  }: { key: string; keyCode: number; written: string; replaces: boolean }
): Promise<void> {
  if (dispatchKey(rig, 'keydown', { key, keyCode })) {
    await nextEventLoop()
    return
  }
  dispatchKey(rig, 'keypress', { key, keyCode, charCode: key.charCodeAt(0) })
  if (replaces) {
    rig.textarea.value = rig.textarea.value.slice(0, -1)
    dispatchInput(rig, 'deleteContentBackward', null)
  }
  rig.textarea.value += written
  dispatchInput(rig, 'insertText', written)
  await nextEventLoop()
}

/**
 * A jamo keystroke. `replaces` is the delete-then-insert the IME uses while a syllable is still
 * growing; without it the syllable is finished and the jamo simply appends.
 */
function typeJamo(
  rig: Rig,
  key: string,
  written: string,
  { replaces }: { replaces: boolean }
): Promise<void> {
  return typePrintable(rig, {
    key,
    keyCode: key.charCodeAt(0),
    written,
    replaces
  })
}

/** `한글`, keystroke for keystroke, as captured from the iPad. */
async function typeHangeul(rig: Rig): Promise<void> {
  await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
  await typeJamo(rig, 'ㅏ', '하', { replaces: true })
  await typeJamo(rig, 'ㄴ', '한', { replaces: true })
  await typeJamo(rig, 'ㄱ', 'ㄱ', { replaces: false })
  await typeJamo(rig, 'ㅡ', '그', { replaces: true })
  await typeJamo(rig, 'ㄹ', '글', { replaces: true })
}

describe('iPadOS Hangul typed as bare keydowns', () => {
  let originalUserAgent: PropertyDescriptor | undefined
  let originalMaxTouchPoints: PropertyDescriptor | undefined

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
    originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    for (const terminal of openTerminals.splice(0)) {
      terminal.dispose()
    }
    if (originalUserAgent) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgent)
    }
    if (originalMaxTouchPoints) {
      Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchPoints)
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends composed syllables, not the jamo the keydowns carry', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted).toEqual(['한', '글', '\r'])
  })

  it('commits a syllable once, with no intermediate state to retract', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeHangeul(rig)

    // Only the syllable the IME finished has been sent; `글` is still open.
    expect(rig.emitted).toEqual(['한'])
    expect(rig.emitted.join('')).not.toContain('\b')
  })

  it('shows the open syllable in the preedit overlay', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    expect(rig.compositionView.classList.contains('active')).toBe(true)
    expect(rig.compositionView.textContent).toContain('ㅎ')

    await typeJamo(rig, 'ㅏ', '하', { replaces: true })
    expect(rig.compositionView.textContent).toContain('하')
    expect(rig.compositionView.textContent).not.toContain('ㅎ')
    expect(rig.emitted).toEqual([])
  })

  it('hides the overlay once the preedit is committed', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.emitted).toEqual(['ㅎ', '\r'])
  })

  it('lets Backspace decompose the open syllable without reaching the pty', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    await typeJamo(rig, 'ㅏ', '하', { replaces: true })

    // The IME walks the syllable back a jamo at a time by rewriting the textarea.
    dispatchKey(rig, 'keydown', {
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8
    })
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'deleteContentBackward', null)
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.compositionView.textContent).toContain('ㅎ')
  })

  it('sends Backspace to the pty once no preedit is open', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    dispatchKey(rig, 'keydown', {
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8
    })
    rig.textarea.value = ''
    dispatchInput(rig, 'deleteContentBackward', null)
    await nextEventLoop()
    expect(rig.emitted).toEqual([])

    dispatchKey(rig, 'keydown', {
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8
    })
    await nextEventLoop()
    expect(rig.emitted).toEqual(['\x7f'])
  })

  it('discards the open syllable on Escape, as a composition does', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchKey(rig, 'keydown', { key: 'Escape', code: 'Escape', keyCode: 27 })
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.textarea.value).toBe('')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('commits the open syllable when the textarea loses focus', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeHangeul(rig)
    rig.textarea.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await nextEventLoop()

    expect(rig.emitted).toEqual(['한', '글'])
  })

  it('commits the open syllable before the space that follows it', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typeHangeul(rig)
    await typePrintable(rig, { key: ' ', keyCode: 32, written: ' ', replaces: false })

    expect(rig.emitted).toEqual(['한', '글', ' '])
  })

  // Chinese pinyin does fire composition events on the same device, so the two paths coexist.
  it('leaves a real composition on the same device to the composition path', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    const start = new CompositionEvent('compositionstart', { bubbles: true })
    Object.defineProperty(start, 'data', { value: '' })
    rig.textarea.dispatchEvent(start)
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: 'ni' })
    rig.textarea.value = 'ni'
    rig.textarea.dispatchEvent(update)
    rig.textarea.value = '\u4f60'
    const end = new CompositionEvent('compositionend', { bubbles: true })
    Object.defineProperty(end, 'data', { value: '\u4f60' })
    rig.textarea.dispatchEvent(end)
    await nextEventLoop()
    await nextEventLoop()

    expect(rig.emitted).toEqual(['\u4f60'])
  })

  // The textarea accumulates across a line, so the preedit is measured from what was already there.
  it('composes after text already sitting in the textarea', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    for (const [key, keyCode] of [
      ['e', 69],
      ['c', 67],
      ['h', 72],
      ['o', 79],
      [' ', 32]
    ] as const) {
      await typePrintable(rig, { key, keyCode, written: key, replaces: false })
    }
    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted.join('')).toBe('echo 한글\r')
  })

  it('leaves ASCII typing on the same device untouched', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    await typePrintable(rig, {
      key: 'l',
      keyCode: 76,
      written: 'l',
      replaces: false
    })
    await typePrintable(rig, {
      key: 's',
      keyCode: 83,
      written: 's',
      replaces: false
    })

    expect(rig.emitted).toEqual(['l', 's'])
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('leaves a desktop Mac on its existing path', async () => {
    pretendTouchIOS(0)
    const rig = openTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    expect(rig.emitted).toEqual(['ㅎ'])
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('leaves screen reader mode on its existing path, so input cannot vanish', async () => {
    pretendTouchIOS()
    const rig = openTerminal({ screenReaderMode: true })
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    expect(rig.emitted).toEqual(['ㅎ'])
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('sends the jamo itself if the IME leaves the textarea alone', async () => {
    pretendTouchIOS()
    const rig = openTerminal()
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    await nextEventLoop()

    expect(rig.emitted).toEqual(['ㅎ'])
  })
})
