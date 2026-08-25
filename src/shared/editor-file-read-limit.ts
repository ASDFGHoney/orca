/**
 * One definition of how many bytes the editor will pull over each transport,
 * plus a machine-readable refusal so the renderer can degrade to an explanatory
 * view instead of a dead "Unable to load file" box.
 *
 * The values deliberately differ per transport and are NOT converging: a local
 * read is a page-cache copy, an SSH read crosses a bounded RPC transport where
 * a large transfer stalls the interactive lanes. Reporting the transport in the
 * refusal is what keeps that honest — the fallback names the limit that was
 * actually applied rather than claiming one shared number.
 */

/** Transport that produced the bytes, not the workspace kind. */
export type EditorFileReadScope = 'local' | 'ssh' | 'runtime'

export const EDITOR_TEXT_READ_LIMIT_BYTES: Record<'local' | 'ssh', number> = {
  local: 50 * 1024 * 1024,
  ssh: 10 * 1024 * 1024
}

/** Previewable binaries are base64 blobs the editor never parses as text. */
export const EDITOR_PREVIEWABLE_BINARY_MAX_BYTES = 50 * 1024 * 1024

export type FileTooLargeDetail = {
  byteLength: number
  limitBytes: number
  scope: EditorFileReadScope
}

const SCOPE_SUBJECT: Record<EditorFileReadScope, string> = {
  local: 'local files',
  ssh: 'files on this SSH host',
  runtime: 'files on this remote workspace'
}

// Why: parsed out of a message rather than a typed error because the refusal
// crosses ipcRenderer.invoke and the relay, both of which flatten errors to a
// string and prepend their own wrapper text.
const DETAIL_PATTERN = /\[size=(\d+) limit=(\d+) scope=(local|ssh|runtime)\]/

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function formatFileTooLargeMessage({
  byteLength,
  limitBytes,
  scope
}: FileTooLargeDetail): string {
  const limitLabel = `${Math.round(limitBytes / 1024 / 1024)}MB`
  return `File too large: ${formatMegabytes(byteLength)} exceeds the ${limitLabel} read limit for ${SCOPE_SUBJECT[scope]}. [size=${byteLength} limit=${limitBytes} scope=${scope}]`
}

export function parseFileTooLargeMessage(message: string): FileTooLargeDetail | null {
  const match = DETAIL_PATTERN.exec(message)
  if (!match) {
    return null
  }
  return {
    byteLength: Number(match[1]),
    limitBytes: Number(match[2]),
    scope: match[3] as EditorFileReadScope
  }
}
