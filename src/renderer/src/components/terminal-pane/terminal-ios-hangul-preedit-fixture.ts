import { Terminal } from '@xterm/xterm'
import { isCurrentPlatformIosWeb } from '../../lib/ios-web-platform'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'
import { createTerminalIosHangulPreeditRenderer } from './terminal-ios-hangul-preedit-overlay'
import {
  installTerminalIosHangulPreedit,
  type TerminalIosHangulPreedit
} from './terminal-ios-hangul-preedit'
import {
  shouldBypassXtermKeyboardEvent,
  shouldSuppressTerminalImeKeyboardEvent
} from './xterm-bypass-policy'

/**
 * Shared rig for the iPadOS Hangul suites: a real xterm `Terminal` wired to the
 * same tracker, bypass policy and preedit controller the pane lifecycle
 * installs, so the tests exercise the whole path rather than a mock of it.
 */

export const IPAD_DESKTOP_MODE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

export type IosHangulRig = {
  compositionView: HTMLElement
  /** Every chunk the terminal handed to the PTY, in order. */
  emitted: string[]
  preedit: TerminalIosHangulPreedit
  terminal: Terminal
  textarea: HTMLTextAreaElement
}

const openTerminals: Terminal[] = []

export function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

/** iPadOS reports a Mac user agent, so the touch-point count is what separates it from a desktop. */
export function pretendIosWeb(maxTouchPoints = 5, userAgent = IPAD_DESKTOP_MODE_UA): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: maxTouchPoints,
    configurable: true
  })
}

export function disposeOpenTerminals(): void {
  for (const terminal of openTerminals.splice(0)) {
    terminal.dispose()
  }
}

export function openIosTerminal(
  options: {
    isIosWeb?: boolean
    /** Overrides the tracker, to isolate what the controller reads it for. */
    isCompositionActive?: () => boolean
    screenReaderMode?: boolean
  } = {}
): IosHangulRig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({
    cols: 40,
    rows: 8,
    screenReaderMode: options.screenReaderMode
  })
  openTerminals.push(terminal)
  terminal.open(container)
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !compositionView) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }

  // Mirrors the lifecycle: the platform decides, so a desktop rig exercises the
  // real gate rather than a flag the test set.
  const isIosWeb = options.isIosWeb ?? isCurrentPlatformIosWeb()
  const tracker = installTerminalImeCompositionTracker(terminal.element)
  const preedit = isIosWeb
    ? installTerminalIosHangulPreedit({
        terminalElement: terminal.element,
        isCompositionActive: options.isCompositionActive ?? (() => tracker.isActive()),
        isScreenReaderMode: () => terminal.options.screenReaderMode === true,
        sendInput: (data) => terminal.input(data),
        renderPreedit: createTerminalIosHangulPreeditRenderer(terminal)
      })
    : { heldText: () => '', dispose: () => undefined }

  terminal.attachCustomKeyEventHandler((event) => {
    if (
      shouldSuppressTerminalImeKeyboardEvent(event, {
        compositionActive: tracker.isActive(),
        candidateKeyGuardActive: tracker.isCandidateKeyGuardActive(),
        pendingCandidateKeyReleaseActive: false,
        hangulPreedit: tracker.isHangulPreedit(),
        isMac: true,
        isLinux: false
      })
    ) {
      return false
    }
    return !shouldBypassXtermKeyboardEvent(event, {
      isMac: true,
      isIosWeb,
      hasSelection: false
    })
  })

  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { compositionView, emitted, preedit, terminal, textarea }
}

export function dispatchKey(
  { textarea }: IosHangulRig,
  type: 'keydown' | 'keypress' | 'keyup',
  init: {
    key: string
    code?: string
    keyCode?: number
    charCode?: number
    shiftKey?: boolean
    isComposing?: boolean
  }
): boolean {
  const event = new KeyboardEvent(type, {
    key: init.key,
    code: init.code ?? 'KeyQ',
    shiftKey: init.shiftKey ?? false,
    bubbles: true,
    cancelable: true
  })
  // happy-dom drops the legacy numeric fields from KeyboardEventInit; xterm's key paths read them.
  Object.defineProperty(event, 'keyCode', { value: init.keyCode ?? init.key.charCodeAt(0) })
  Object.defineProperty(event, 'charCode', { value: init.charCode ?? 0 })
  Object.defineProperty(event, 'isComposing', { value: init.isComposing ?? false })
  textarea.dispatchEvent(event)
  return event.defaultPrevented
}

export function dispatchInput(
  { textarea }: IosHangulRig,
  inputType: string,
  data: string | null,
  init: { isComposing?: boolean } = {}
): void {
  const event = new InputEvent('input', { bubbles: true })
  Object.defineProperty(event, 'inputType', { value: inputType })
  Object.defineProperty(event, 'data', { value: data })
  Object.defineProperty(event, 'isComposing', { value: init.isComposing ?? false })
  // Trusted user events are always composed; that is the flag that makes xterm drop the commit.
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

export function dispatchComposition(
  { textarea }: IosHangulRig,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data?: string
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

/**
 * One printable keystroke as a browser produces it: the key, then — only if
 * xterm did not consume the keydown — the keypress and the text the IME writes.
 */
export async function typePrintable(
  rig: IosHangulRig,
  {
    key,
    keyCode,
    written,
    replaces,
    shiftKey
  }: {
    key: string
    keyCode: number
    written: string
    replaces: boolean
    shiftKey?: boolean
  }
): Promise<void> {
  if (dispatchKey(rig, 'keydown', { key, keyCode, shiftKey })) {
    await nextEventLoop()
    return
  }
  dispatchKey(rig, 'keypress', { key, keyCode, charCode: key.charCodeAt(0), shiftKey })
  if (replaces) {
    rig.textarea.value = rig.textarea.value.slice(0, -1)
    dispatchInput(rig, 'deleteContentBackward', null)
  }
  rig.textarea.value += written
  dispatchInput(rig, 'insertText', written)
  await nextEventLoop()
}

/**
 * A jamo keystroke. `replaces` is the delete-then-insert the IME uses while a
 * syllable is still growing; without it the syllable is finished and the jamo
 * simply appends.
 */
export function typeJamo(
  rig: IosHangulRig,
  key: string,
  written: string,
  options: { replaces: boolean; shiftKey?: boolean }
): Promise<void> {
  return typePrintable(rig, {
    key,
    keyCode: key.charCodeAt(0),
    written,
    replaces: options.replaces,
    shiftKey: options.shiftKey
  })
}

/** `한글`, keystroke for keystroke, as captured from the iPad. */
export async function typeHangeul(rig: IosHangulRig): Promise<void> {
  await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
  await typeJamo(rig, 'ㅏ', '하', { replaces: true })
  await typeJamo(rig, 'ㄴ', '한', { replaces: true })
  await typeJamo(rig, 'ㄱ', 'ㄱ', { replaces: false })
  await typeJamo(rig, 'ㅡ', '그', { replaces: true })
  await typeJamo(rig, 'ㄹ', '글', { replaces: true })
}
