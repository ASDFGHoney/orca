import type { FileReadLimits } from '../providers/types'
import {
  MAX_PREVIEWABLE_BINARY_BYTES,
  MAX_REMOTE_TEXT_FILE_BYTES
} from '../../shared/editor-file-read-limits'

export function sshFileStreamReadCap(isBinary: boolean, limits?: FileReadLimits): number {
  const defaultCap = isBinary ? MAX_PREVIEWABLE_BINARY_BYTES : MAX_REMOTE_TEXT_FILE_BYTES
  const requestedCap = isBinary ? limits?.maxBinaryBytes : limits?.maxTextBytes
  return requestedCap === undefined ? defaultCap : Math.min(defaultCap, requestedCap)
}
