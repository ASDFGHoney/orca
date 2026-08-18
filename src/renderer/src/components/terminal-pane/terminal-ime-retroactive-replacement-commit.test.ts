// @vitest-environment happy-dom
/**
 * A text system that rewrites text the terminal has already sent.
 *
 * Every substitution the rest of the suite covers is decided before or during the keystroke that
 * produces it — `,` commits as `，`, a `DefaultKeyBinding.dict` remap commits a backquote. One
 * keydown, one character, no rewrite of anything already on the wire. That is an *input source*
 * substitution and carrying it is what this forwarder exists for.
 *
 * macOS automatic period substitution is a different thing wearing the same clothes. It is a text
 * *editing* convenience: type a second space and the system deletes the first one and inserts
 * `". "` in its place. It reaches a browser text field — the helper textarea is one, and
 * `autocorrect`/`spellcheck` do not govern the system text service — but it reaches no reference
 * terminal, because none of them is a text view. Four were checked on hardware and all four
 * deliver two spaces. The dash, smart-quote and text-replacement rules are the same family.
 *
 * So the rewrite is declined, and the keystroke sends what the key itself produced. The bug this
 * pins is that it used to send *nothing at all*: the deletion arrives as an input event whose type
 * is not `insertText`, which retired the claim without emitting, and the replacing `insertText`
 * then found no claim to attach to. Two spaces became one.
 *
 * The discriminator is structural rather than a character table — a one-key-one-character
 * substitution never deletes first — so nothing here reads which characters were involved.
 */ import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { shouldBypassXtermKeyboardEvent } from './xterm-bypass-policy'

/** What a cooked tty leaves on the line after the erases the terminal sent are applied. */
function resolveLine(sent: string): string {
  const line: string[] = []
  for (const character of sent) {
    if (character === '\x7f' || character === '\b') {
      line.pop()
      continue
    }
    line.push(character)
  }
  return line.join('')
}

function open(kittyKeyboardFlags = 0): {
  sent: () => string
  textarea: HTMLTextAreaElement
  dispose: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => false,
    sendInput: (data) => terminal.input(data),
    getKittyKeyboardFlags: () => kittyKeyboardFlags
  })
  terminal.attachCustomKeyEventHandler((event) => {
    if (forwarder.claimKeyEvent(event)) {
      return false
    }
    return !shouldBypassXtermKeyboardEvent(event, {
      isMac: true,
      hasSelection: false,
      kittyKeyboardFlags
    })
  })
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return {
    sent: () => emitted.join(''),
    textarea: terminal.textarea!,
    dispose: () => {
      forwarder.dispose()
      terminal.dispose()
    }
  }
}

function key(
  textarea: HTMLTextAreaElement,
  type: string,
  init: { key: string; code: string; keyCode: number }
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    key: init.key,
    code: init.code,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  Object.defineProperty(event, 'charCode', { value: type === 'keypress' ? init.keyCode : 0 })
  textarea.dispatchEvent(event)
  return event
}

function inputEvent(textarea: HTMLTextAreaElement, inputType: string, data: string | null): void {
  const event = new InputEvent('input', { bubbles: true })
  Object.defineProperty(event, 'inputType', { value: inputType })
  Object.defineProperty(event, 'data', { value: data })
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

/** A printable key the text system commits verbatim, in the order Chromium delivers it. */
function pressPrintable(
  textarea: HTMLTextAreaElement,
  character: string,
  code: string,
  keyCode: number
): void {
  const keydown = key(textarea, 'keydown', { key: character, code, keyCode })
  if (!keydown.defaultPrevented) {
    key(textarea, 'keypress', {
      key: character,
      code,
      keyCode: character.charCodeAt(0)
    })
  }
  textarea.value += character
  inputEvent(textarea, 'insertText', character)
  key(textarea, 'keyup', { key: character, code, keyCode })
}

/**
 * The substituting keystroke: a keydown the text system swallows, then a keyless rewrite of text
 * the terminal has already sent.
 */
function pressReplacing(
  textarea: HTMLTextAreaElement,
  press: { key: string; code: string; keyCode: number },
  replacement: { deleteCount: number; insertedText: string }
): void {
  key(textarea, 'keydown', press)
  const retained = Array.from(textarea.value)
  retained.splice(retained.length - replacement.deleteCount, replacement.deleteCount)
  textarea.value = retained.join('')
  inputEvent(textarea, 'deleteContentBackward', null)
  textarea.value += replacement.insertedText
  inputEvent(textarea, 'insertText', replacement.insertedText)
  key(textarea, 'keyup', press)
}

describe('a text substitution decided after the terminal already sent the text', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  // Guards the cases below from passing vacuously: if this harness stopped reaching the
  // forwarder's listeners at all, a decline and a silent drop would look identical.
  it('delivers a non-replacing commit through the same harness', () => {
    const pane = open()
    try {
      pressPrintable(pane.textarea, 'a', 'KeyA', 65)
      pressPrintable(pane.textarea, 'b', 'KeyB', 66)
      expect(resolveLine(pane.sent())).toBe('ab')
    } finally {
      pane.dispose()
    }
  })

  // The declining rule itself. Two spaces in, two spaces out, and no period invented — which is
  // what every reference terminal does with these keystrokes.
  it('declines a rewrite and sends what the key produced', () => {
    const pane = open()
    try {
      pressPrintable(pane.textarea, 'a', 'KeyA', 65)
      pressPrintable(pane.textarea, 'b', 'KeyB', 66)
      pressPrintable(pane.textarea, ' ', 'Space', 32)
      pressReplacing(
        pane.textarea,
        { key: ' ', code: 'Space', keyCode: 32 },
        { deleteCount: 1, insertedText: '. ' }
      )
      expect(resolveLine(pane.sent())).toBe('ab  ')
    } finally {
      pane.dispose()
    }
  })

  // The regression that motivated all of this: before the fix the deletion retired the claim and
  // the keystroke produced no bytes, so the user lost the space entirely.
  it('does not swallow the keystroke the rewrite was attached to', () => {
    const pane = open()
    try {
      pressReplacing(
        pane.textarea,
        { key: ' ', code: 'Space', keyCode: 32 },
        { deleteCount: 0, insertedText: '. ' }
      )
      expect(pane.sent()).not.toBe('')
    } finally {
      pane.dispose()
    }
  })

  // Same family, same rule: `--` must stay `--` rather than becoming an em dash.
  it('declines a dash substitution', () => {
    const pane = open()
    try {
      pressPrintable(pane.textarea, '-', 'Minus', 189)
      pressReplacing(
        pane.textarea,
        { key: '-', code: 'Minus', keyCode: 189 },
        { deleteCount: 1, insertedText: '—' }
      )
      expect(resolveLine(pane.sent())).toBe('--')
    } finally {
      pane.dispose()
    }
  })

  // Bit 3 asks for every printable key as a CSI-u report. The declining rule has to hold there
  // too: the report identity is the physical key, and the substituted character must not ride
  // along as associated text.
  // Why flags 24 and not 8: bit 3 alone emits no associated text, so asserting the
  // substitution is absent there passes whatever the code does. Bit 4 is what carries
  // the text, so it is the only place the decline is observable.
  it('declines a rewrite on a pane that negotiated kitty associated text', () => {
    const pane = open(24)
    try {
      pressReplacing(
        pane.textarea,
        { key: ' ', code: 'Space', keyCode: 32 },
        { deleteCount: 1, insertedText: '. ' }
      )
      const sent = pane.sent()
      expect(sent).not.toBe('')
      // The associated text must be the space the key produced (U+0020 = 32), not the
      // substituted '. ' the text system offered.
      expect(sent).toContain(';32u')
      expect(sent).not.toContain('.')
    } finally {
      pane.dispose()
    }
  })
})
