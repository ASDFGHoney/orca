import { describe, expect, it } from 'vitest'
import {
  EDITOR_PREVIEWABLE_BINARY_MAX_BYTES,
  EDITOR_TEXT_READ_LIMIT_BYTES,
  formatFileTooLargeMessage,
  parseFileTooLargeMessage
} from './editor-file-read-limit'

describe('editor file read limits', () => {
  // Guards #1367 ("Allow large text files to open in editor") against a silent
  // revert: a later consistency pass must not quietly shrink the local budget.
  it('keeps the local text budget at 50MB', () => {
    expect(EDITOR_TEXT_READ_LIMIT_BYTES.local).toBe(50 * 1024 * 1024)
    expect(EDITOR_PREVIEWABLE_BINARY_MAX_BYTES).toBe(50 * 1024 * 1024)
  })

  it('keeps the lower SSH budget the transports actually enforce', () => {
    expect(EDITOR_TEXT_READ_LIMIT_BYTES.ssh).toBe(10 * 1024 * 1024)
  })

  it('round-trips the too-large message through an IPC wrapper prefix', () => {
    const message = formatFileTooLargeMessage({
      byteLength: 53_477_376,
      limitBytes: EDITOR_TEXT_READ_LIMIT_BYTES.local,
      scope: 'local'
    })
    expect(message).toContain('51.0MB')
    expect(message).toContain('50MB')

    const wrapped = `Error invoking remote method 'fs:readFile': Error: ${message}`
    expect(parseFileTooLargeMessage(wrapped)).toEqual({
      byteLength: 53_477_376,
      limitBytes: 52_428_800,
      scope: 'local'
    })
  })

  // The editor's automatic backoff keys off this prefix; a size refusal is
  // deterministic, so retrying it just burns the budget.
  it('keeps the prefix the retry gate treats as terminal', () => {
    for (const scope of ['local', 'ssh', 'runtime'] as const) {
      expect(
        formatFileTooLargeMessage({ byteLength: 1, limitBytes: 1, scope }).toLowerCase()
      ).toContain('file too large')
    }
  })

  it('names the transport so the fallback never claims one shared limit', () => {
    const ssh = formatFileTooLargeMessage({
      byteLength: 12_000_000,
      limitBytes: EDITOR_TEXT_READ_LIMIT_BYTES.ssh,
      scope: 'ssh'
    })
    expect(parseFileTooLargeMessage(ssh)?.scope).toBe('ssh')
    expect(parseFileTooLargeMessage('some unrelated read failure')).toBeNull()
  })
})
