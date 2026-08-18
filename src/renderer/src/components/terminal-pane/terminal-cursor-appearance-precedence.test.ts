// @vitest-environment happy-dom
/**
 * Issue #12729's second claim — "`terminalCursorStyle` / `terminalCursorOpacity` are ignored".
 *
 * Neither reproduces as a plumbing defect: an explicit `bar` survives the settings round trip and
 * the opacity composes into the theme's cursor colour. What the report was looking at is the IME
 * preedit overlay, which no cursor option reaches by construction
 * (`terminal-ime-xterm-trailing-preedit-occlusion.test.ts`).
 *
 * The one thing that does override the preference is a `DECSCUSR` from the running program, which
 * every terminal honours and which prompt frameworks emit routinely. That precedence is pinned
 * here because it is the answer to "my setting does nothing" whenever the overlay is not involved.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeTerminalCursorStyleDefault } from '../../../../shared/terminal-cursor-style-settings'
import { composeActiveTerminalTheme } from './terminal-appearance'

function decPrivateCursorStyle(terminal: Terminal): string | undefined {
  return (
    terminal as unknown as {
      _core: { coreService: { decPrivateModes: { cursorStyle?: string } } }
    }
  )._core.coreService.decPrivateModes.cursorStyle
}

describe('#12729 — cursor style and opacity reach the terminal', () => {
  it('keeps an explicitly chosen bar across the settings write and the next load', () => {
    // The write path stamps the migration flag alongside the user's choice.
    const written = normalizeTerminalCursorStyleDefault(
      { terminalCursorStyle: 'bar' },
      { preserveExplicitValue: true }
    )
    expect(written).toEqual({
      terminalCursorStyle: 'bar',
      terminalCursorStyleDefaultedToBlock: true
    })

    // The load path re-runs the migration over what was persisted and must not re-default it.
    expect(normalizeTerminalCursorStyleDefault(written).terminalCursorStyle).toBe('bar')
  })

  it('composes terminalCursorOpacity into the theme cursor colour', () => {
    const theme = composeActiveTerminalTheme(
      { background: '#112233', foreground: '#aabbcc', cursor: '#ffffff' },
      { terminalCursorOpacity: 0.1 }
    )

    expect(theme?.cursor).toBe('rgba(255, 255, 255, 0.1)')
  })
})

describe('#12729 — DECSCUSR from the program outranks the preference', () => {
  const openTerminals: Terminal[] = []

  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('pins the shape a prompt asked for until CSI 0 SP q hands it back', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal({ cols: 40, rows: 6, cursorStyle: 'bar' })
    terminal.open(container)
    openTerminals.push(terminal)

    expect(decPrivateCursorStyle(terminal)).toBeUndefined()

    // `CSI 2 SP q` — steady block, what a prompt framework emits on every redraw.
    await new Promise<void>((resolve) => terminal.write('\x1b[2 q', resolve))
    expect(decPrivateCursorStyle(terminal)).toBe('block')

    // Changing the preference while that is set cannot win it back; only the reset does.
    terminal.options.cursorStyle = 'underline'
    expect(decPrivateCursorStyle(terminal)).toBe('block')

    // Orca sends this reset on replay and on the agent-idle path (RESET_TERMINAL_CURSOR_STYLE).
    await new Promise<void>((resolve) => terminal.write('\x1b[0 q', resolve))
    expect(decPrivateCursorStyle(terminal)).toBeUndefined()
  })
})
