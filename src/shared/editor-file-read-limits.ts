/**
 * File-read budgets and the "File too large" message shape, shared by every editor read
 * path — local IPC, relay, and SSH — so producers and the renderer that parses them agree.
 */

// Why: Monaco degrades features on large files like VS Code, so a smaller block would
// needlessly lock out ordinary JSON/CSV/log files that local reads can hold in memory.
export const MAX_LOCAL_TEXT_FILE_BYTES = 50 * 1024 * 1024
// Why: lower than local because the legacy single-shot fs.readFile reply carries the whole
// file in one JSON-RPC frame, and MAX_MESSAGE_SIZE is 16MB before JSON escaping.
export const MAX_REMOTE_TEXT_FILE_BYTES = 10 * 1024 * 1024
// Why: previewable binaries are base64 blobs handed to a viewer, never parsed as text or
// tokenized, and reads above the legacy 16MB single-frame budget go through fs.readFileStream.
export const MAX_PREVIEWABLE_BINARY_BYTES = 50 * 1024 * 1024

export function fileTooLargeMessage(observedBytes: number, maxBytes: number): string {
  return `File too large: ${(observedBytes / 1024 / 1024).toFixed(1)}MB exceeds ${maxBytes / 1024 / 1024}MB limit`
}

// Why: unit symbol, not prose — kept out of JSX so the localization audit does not read it as copy.
export function megabytesLabel(megabytes: number, fractionDigits = 0): string {
  return `${megabytes.toFixed(fractionDigits)} MB`
}

// Why: IPC and RPC rejections reach the renderer as a plain string, so the shape is parsed back here
// rather than re-derived — keeping the producer and the consumer in one file.
const FILE_TOO_LARGE_PATTERN = /File too large: (\d+(?:\.\d+)?)MB exceeds (\d+(?:\.\d+)?)MB limit/

export type FileTooLargeDetails = { observedMb: number; limitMb: number }

export function parseFileTooLargeMessage(message: string): FileTooLargeDetails | null {
  const match = FILE_TOO_LARGE_PATTERN.exec(message)
  if (!match) {
    return null
  }
  return { observedMb: Number(match[1]), limitMb: Number(match[2]) }
}
