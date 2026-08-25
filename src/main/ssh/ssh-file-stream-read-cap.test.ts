import { describe, expect, it } from 'vitest'
import { sshFileStreamReadCap } from './ssh-file-stream-read-cap'
import {
  MAX_PREVIEWABLE_BINARY_BYTES,
  MAX_REMOTE_TEXT_FILE_BYTES
} from '../../shared/editor-file-read-limits'
import {
  MAX_PREVIEWABLE_BINARY_SIZE as RELAY_BINARY_CAP,
  MAX_TEXT_FILE_SIZE as RELAY_TEXT_CAP
} from '../../relay/fs-handler-utils'

describe('sshFileStreamReadCap', () => {
  // Regression: the SSH cap and the relay cap were separate literals that could drift apart.
  it('shares one budget with the relay read path', () => {
    expect(sshFileStreamReadCap(false)).toBe(MAX_REMOTE_TEXT_FILE_BYTES)
    expect(sshFileStreamReadCap(true)).toBe(MAX_PREVIEWABLE_BINARY_BYTES)
    expect(RELAY_TEXT_CAP).toBe(MAX_REMOTE_TEXT_FILE_BYTES)
    expect(RELAY_BINARY_CAP).toBe(MAX_PREVIEWABLE_BINARY_BYTES)
  })

  it('clamps a client-requested cap to the shared budget', () => {
    expect(sshFileStreamReadCap(false, { maxTextBytes: Number.MAX_SAFE_INTEGER })).toBe(
      MAX_REMOTE_TEXT_FILE_BYTES
    )
    expect(sshFileStreamReadCap(false, { maxTextBytes: 1024 })).toBe(1024)
  })
})
