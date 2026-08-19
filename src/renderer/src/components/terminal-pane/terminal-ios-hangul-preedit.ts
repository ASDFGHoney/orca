import type { IDisposable } from '@xterm/xterm'
import { isHangulJamoKeyText } from './hangul-jamo-key'

// Why: iPadOS composes Hangul from a hardware keyboard with no composition
// events at all (#13345). Each jamo arrives as a plain keydown while the IME
// rewrites the syllable in place in the helper textarea —
// `deleteContentBackward` then a replacing `insertText`. xterm consumes the
// keydown, so the raw compatibility jamo reaches the PTY and the composed
// syllable is dropped: `한글` arrives as `ㅎㅏㄴㄱㅡㄹ`.
//
// The keydown is handed to the system by `shouldBypassXtermForIosTextEdit`, and
// the syllable it builds is held here until the IME proves it is final —
// nothing is ever sent and then retracted, so raw-mode TUIs never see DEL bytes
// they would have to interpret as "erase one cell".
//
// Everything is driven from `input`. iPadOS delivers it later than a macrotask,
// so any timer-based read of the field loses the race and concludes, wrongly,
// that nothing was composed.

type OpenPreedit = {
  /** Field text preceding the syllable; everything after it is uncommitted. */
  baseValue: string
  /** The syllable being held: shown, not sent. */
  heldText: string
  /** The jamo that opened the hold, owed to the PTY if the IME never writes. */
  openKey: string
  /** What the last keydown asked the IME to do to the syllable. */
  editKind: 'compose' | 'erase'
}

export type TerminalIosHangulPreedit = IDisposable & {
  /** The syllable currently held back from the PTY, or '' when none is. */
  heldText: () => string
}

export type TerminalIosHangulPreeditOptions = {
  terminalElement: HTMLElement | null | undefined
  /** Whether a composition session is under way, which bars a hold from opening
   *  over it — Chinese pinyin on the same device does run one, and xterm's
   *  CompositionHelper already commits it. Must be derived and expiring, not
   *  latched: a session that never ends would otherwise disable the pane. */
  isCompositionActive: () => boolean
  /** Screen reader mode writes the textarea itself, so a field diff would not
   *  be the IME's alone. */
  isScreenReaderMode: () => boolean
  sendInput: (data: string) => void
  /** Draws the open syllable; called with '' when there is none. */
  renderPreedit?: (text: string) => void
}

const NO_OP_PREEDIT: TerminalIosHangulPreedit = {
  heldText: () => '',
  dispose: () => undefined
}

function asHelperTextarea(target: EventTarget | null): HTMLTextAreaElement | null {
  if (!(target instanceof HTMLTextAreaElement)) {
    return null
  }
  return target.classList.contains('xterm-helper-textarea') ? target : null
}

function isUnmodified(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.altKey && !event.metaKey
}

function isJamoKey(event: KeyboardEvent): boolean {
  return isHangulJamoKeyText(event.key) && isUnmodified(event)
}

function isDeletion(event: Event): boolean {
  return event instanceof InputEvent && event.inputType.startsWith('delete')
}

/** True for input the browser attributes to a composition session, whichever
 *  order it interleaves those events in. */
function isCompositionOwnedInput(event: Event): boolean {
  return (
    event instanceof InputEvent &&
    (event.isComposing === true || event.inputType === 'insertCompositionText')
  )
}

/**
 * Holds the Hangul syllable iPadOS is still building and commits it only once
 * the IME proves it final, so the PTY sees one write per syllable.
 */
export function installTerminalIosHangulPreedit(
  options: TerminalIosHangulPreeditOptions
): TerminalIosHangulPreedit {
  const root = options.terminalElement
  if (!root) {
    return NO_OP_PREEDIT
  }

  let preedit: OpenPreedit | null = null

  const render = (text: string): void => options.renderPreedit?.(text)

  const close = (): void => {
    preedit = null
    render('')
  }

  const commit = (): void => {
    const open = preedit
    if (!open) {
      return
    }
    // A hold the IME never wrote to still owes the keystroke it swallowed.
    const text = open.heldText || (isHangulJamoKeyText(open.openKey) ? open.openKey : '')
    close()
    if (text) {
      options.sendInput(text)
    }
  }

  const discard = (textarea: HTMLTextAreaElement): void => {
    const open = preedit
    if (!open) {
      return
    }
    // The cancelled syllable never reached the PTY, so it must not survive in
    // the field either.
    textarea.value = open.baseValue
    close()
  }

  /**
   * Re-derives the hold from the field. The IME replaces the syllable it is
   * still building and only appends once that syllable is final, so a tail that
   * grew past what is held is the one signal that releases it.
   */
  const sync = (textarea: HTMLTextAreaElement): void => {
    const open = preedit
    if (!open) {
      return
    }
    const value = textarea.value
    if (!value.startsWith(open.baseValue)) {
      // The field was rewritten out from under the hold; commit rather than
      // measure against text that is gone.
      commit()
      return
    }
    let tail = value.slice(open.baseValue.length)
    if (tail.length === 0) {
      // Backspace erased the syllable's last jamo. None of it was sent, so
      // nothing needs undoing — and the next Backspace is the PTY's.
      close()
      return
    }
    if (
      open.heldText.length > 0 &&
      tail.length > open.heldText.length &&
      tail.startsWith(open.heldText)
    ) {
      const settled = open.heldText
      open.baseValue += settled
      tail = tail.slice(settled.length)
      options.sendInput(settled)
    }
    open.heldText = tail
    render(tail)
  }

  const handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return
    }
    const textarea = root.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!textarea) {
      return
    }
    if (preedit) {
      preedit.editKind = 'compose'
      if (event.key === 'Escape' && isUnmodified(event)) {
        // Escape cancels the syllable the way it cancels a composition. Stopped
        // here so xterm cannot also send it; the default action still lets the
        // IME clear its own state.
        event.stopImmediatePropagation()
        discard(textarea)
        return
      }
      if (event.key === 'Backspace' && isUnmodified(event)) {
        // Backspace decomposes the held syllable in the field rather than
        // erasing a written cell, so it must not reach the PTY as DEL.
        preedit.editKind = 'erase'
        event.stopImmediatePropagation()
        return
      }
      if (isJamoKey(event)) {
        return
      }
      // Anything else ends the syllable, and runs before xterm sends the key.
      commit()
      return
    }
    if (
      isJamoKey(event) &&
      event.isComposing !== true &&
      !options.isCompositionActive() &&
      !options.isScreenReaderMode()
    ) {
      preedit = {
        baseValue: textarea.value,
        heldText: '',
        openKey: event.key,
        editKind: 'compose'
      }
    }
  }

  const handleInput = (event: Event): void => {
    if (!preedit) {
      return
    }
    const textarea = asHelperTextarea(event.target)
    if (!textarea) {
      return
    }
    if (isCompositionOwnedInput(event)) {
      // A session took the field over; it owns the commit from here. Read off
      // the event rather than the session state, so this cannot depend on which
      // `input` listener on the pane element happens to run first.
      commit()
      return
    }
    // Why: the field keeps the syllable so the IME can rewrite it, and xterm
    // must not read that as fresh input.
    event.stopImmediatePropagation()
    if (preedit.editKind === 'compose' && isDeletion(event)) {
      // Half of the delete-then-insert the IME uses to replace a growing
      // syllable. Reading the field between the two would see it emptied.
      return
    }
    sync(textarea)
  }

  // A real session owns the field from here, so anything held is final.
  const handleCompositionStart = (): void => commit()
  const handleBlur = (): void => commit()

  root.addEventListener('keydown', handleKeyDown, true)
  root.addEventListener('input', handleInput, true)
  root.addEventListener('compositionstart', handleCompositionStart, true)
  root.addEventListener('blur', handleBlur, true)

  return {
    heldText: () => preedit?.heldText ?? '',
    dispose: () => {
      root.removeEventListener('keydown', handleKeyDown, true)
      root.removeEventListener('input', handleInput, true)
      root.removeEventListener('compositionstart', handleCompositionStart, true)
      root.removeEventListener('blur', handleBlur, true)
      close()
    }
  }
}
