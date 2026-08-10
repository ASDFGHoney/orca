// Pure bracketed-paste framing for paths that write PTY bytes directly
// (mobile clipboard paste, shared send helpers). Renderer/xterm keeps its own
// terminal-object helpers; keep these free of DOM so mobile can import them.

export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

const ESCAPE = '\x1b'
// Why: U+241B is the printable ESC substitute xterm/desktop paste uses.
const INERT_ESCAPE = '\u241b'

/** Strip/neutralize bytes that would close a bracketed-paste frame early. */
export function sanitizeBracketedPasteText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}${INERT_ESCAPE}`
    start = escapeIndex + ESCAPE.length
    escapeIndex = text.indexOf(ESCAPE, start)
  }
  return sanitized + text.slice(start)
}

// Why: xterm's native paste converts newlines to CR; ConPTY TUIs treat raw LF as submit.
export function normalizeTerminalPasteLineEndings(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

export function wrapTerminalBracketedPasteText(text: string): string {
  const normalizedText = normalizeTerminalPasteLineEndings(text)
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalizedText)}${BRACKETED_PASTE_END}`
}

export type TerminalBracketedPasteModes = {
  bracketedPasteMode?: boolean
  altScreen?: boolean
}

/**
 * Frame clipboard text for a direct terminal.send paste.
 *
 * Gate only on DECSET 2004. Full-screen TUIs (Claude Code, etc.) enable
 * bracketed paste while on the alternate screen; also requiring `!altScreen`
 * left those pastes unframed so the host OS delivered them as ~1 KiB chunks
 * that some agent composers silently collapse to the final fragment.
 */
export function buildTerminalClipboardPasteText(
  text: string,
  modes: TerminalBracketedPasteModes | undefined
): string {
  if (modes?.bracketedPasteMode !== true) {
    return text
  }
  return wrapTerminalBracketedPasteText(text)
}
