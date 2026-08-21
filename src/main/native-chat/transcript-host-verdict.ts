import { FileRangeReadUnsupportedError } from '../providers/types'
import { SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

export const TRANSCRIPT_UNVERIFIABLE_MESSAGE = 'Transcript unverifiable on the remote host'
export const DEFAULT_TRANSCRIPT_UNRESOLVED_NOTICE_MS = 60_000
export const UNRESOLVED_TRANSCRIPT_MESSAGE =
  'No transcript found for this session on this machine. If the agent runs on a remote host its transcript lives there; otherwise it may not have been written yet.'

export class TranscriptHostUnverifiableError extends Error {
  readonly verdict = 'unverifiable' as const

  constructor(message = TRANSCRIPT_UNVERIFIABLE_MESSAGE) {
    super(message)
    this.name = 'TranscriptHostUnverifiableError'
  }
}

export function isTranscriptHostUnverifiableError(error: unknown): boolean {
  if (
    error instanceof TranscriptHostUnverifiableError ||
    error instanceof FileRangeReadUnsupportedError
  ) {
    return true
  }
  const candidate = error as { code?: unknown; message?: unknown } | null
  return (
    candidate?.code === 'CONNECTION_LOST' ||
    candidate?.code === 'DISPOSED' ||
    candidate?.code === 'SSH_SESSION_EXPIRED' ||
    candidate?.message === SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
  )
}

export function transcriptUnverifiableResult(): { error: string; unverifiable: true } {
  return { error: TRANSCRIPT_UNVERIFIABLE_MESSAGE, unverifiable: true }
}

export function transcriptInitialReadErrorMessage(error: unknown): string {
  if (error instanceof WslTranscriptFsError) {
    return error.message
  }
  return isTranscriptHostUnverifiableError(error)
    ? TRANSCRIPT_UNVERIFIABLE_MESSAGE
    : 'Transcript unavailable'
}
