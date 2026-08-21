import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import { getSshFilesystemProviderSnapshot } from '../providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from '../providers/types'
import { TranscriptHostUnverifiableError } from './transcript-host-verdict'
import {
  TranscriptRangeReadInvalidatedError,
  type TranscriptFileStamp,
  type TranscriptRangeFs
} from './transcript-range-fs'

type ProviderGeneration = {
  provider: IFilesystemProvider
  generation: number
}

function requireSameProvider(connectionId: string, expected: ProviderGeneration): void {
  const current = getSshFilesystemProviderSnapshot(connectionId)
  if (
    !current ||
    current.provider !== expected.provider ||
    current.generation !== expected.generation
  ) {
    throw new TranscriptHostUnverifiableError()
  }
}

export async function createSshTranscriptRangeFs(
  connectionId: string,
  signal?: AbortSignal
): Promise<TranscriptRangeFs> {
  const snapshot = getSshFilesystemProviderSnapshot(connectionId)
  if (!snapshot?.provider.readFileRange) {
    throw new TranscriptHostUnverifiableError()
  }
  if (
    snapshot.provider.supportsFileRangeRead &&
    !(await snapshot.provider.supportsFileRangeRead({ signal }))
  ) {
    throw new TranscriptHostUnverifiableError()
  }
  const providerSnapshot: ProviderGeneration = snapshot
  requireSameProvider(connectionId, providerSnapshot)
  const provider = providerSnapshot.provider
  async function stat(filePath: string, statSignal?: AbortSignal): Promise<TranscriptFileStamp> {
    statSignal?.throwIfAborted()
    requireSameProvider(connectionId, providerSnapshot)
    const stamp = await provider.stat(filePath)
    requireSameProvider(connectionId, providerSnapshot)
    const mtimeMs = stamp.mtimeMs ?? stamp.mtime
    return {
      size: stamp.size,
      identity: `${providerSnapshot.generation}:${stamp.dev ?? 0}:${stamp.ino ?? 0}`,
      identityReliable: stamp.dev !== undefined && stamp.ino !== undefined,
      mtimeMs,
      ctimeMs: mtimeMs
    }
  }
  const rangeFs: TranscriptRangeFs = {
    stat,
    async read(filePath, position, length, readSignal) {
      readSignal?.throwIfAborted()
      const parts: Buffer[] = []
      let remaining = length
      let cursor = position
      while (remaining > 0) {
        requireSameProvider(connectionId, providerSnapshot)
        const window = Math.min(remaining, MAX_FILE_RANGE_READ_BYTES)
        const result = await provider.readFileRange!(filePath, cursor, window, {
          signal: readSignal
        })
        requireSameProvider(connectionId, providerSnapshot)
        const bytes = result.bytes.subarray(0, result.bytesRead)
        parts.push(bytes)
        cursor += bytes.length
        remaining -= bytes.length
        if (bytes.length < window) {
          break
        }
      }
      return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    },
    async assertStable(filePath, openingStamp, stableSignal) {
      const closingStamp = await stat(filePath, stableSignal)
      const identityChanged = closingStamp.identity !== openingStamp.identity
      const unpinnedVersionChanged =
        !openingStamp.identityReliable && closingStamp.mtimeMs !== openingStamp.mtimeMs
      if (identityChanged || unpinnedVersionChanged) {
        throw new TranscriptRangeReadInvalidatedError()
      }
    }
  }
  return rangeFs
}
