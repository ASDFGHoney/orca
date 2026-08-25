import { describe, expect, it } from 'vitest'
import {
  MAX_LOCAL_TEXT_FILE_BYTES,
  MAX_PREVIEWABLE_BINARY_BYTES,
  MAX_REMOTE_TEXT_FILE_BYTES,
  fileTooLargeMessage,
  megabytesLabel,
  parseFileTooLargeMessage
} from './editor-file-read-limits'

describe('editor file read limits', () => {
  // Regression: the local budget was cut to the remote one, locking out 14MB JSON/CSV files
  // that Monaco already handles. The remote budget is transport-bound and stays where it is.
  it('keeps the local budget above the frame-bound remote one', () => {
    expect(MAX_LOCAL_TEXT_FILE_BYTES).toBe(50 * 1024 * 1024)
    expect(MAX_REMOTE_TEXT_FILE_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_PREVIEWABLE_BINARY_BYTES).toBe(50 * 1024 * 1024)
  })

  it('parses the message every read path emits', () => {
    const message = fileTooLargeMessage(14 * 1024 * 1024, MAX_REMOTE_TEXT_FILE_BYTES)

    expect(message).toBe('File too large: 14.0MB exceeds 10MB limit')
    expect(parseFileTooLargeMessage(message)).toEqual({ observedMb: 14, limitMb: 10 })
  })

  it('parses the message after IPC prefixes the invoke channel', () => {
    expect(
      parseFileTooLargeMessage(
        "Error invoking remote method 'fs:readFile': Error: File too large: 51.2MB exceeds 10MB limit"
      )
    ).toEqual({ observedMb: 51.2, limitMb: 10 })
  })

  it('labels megabytes for display', () => {
    expect(megabytesLabel(14.03, 1)).toBe('14.0 MB')
    expect(megabytesLabel(10)).toBe('10 MB')
  })

  it('ignores unrelated load failures', () => {
    expect(
      parseFileTooLargeMessage('Access denied: path resolves outside allowed directories')
    ).toBe(null)
  })
})
