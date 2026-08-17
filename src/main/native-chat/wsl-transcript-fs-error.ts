export const WSL_TRANSCRIPT_FS_SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'
export const WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE =
  'WSL transcript discovery is temporarily unavailable because too many filesystem requests are already waiting. Try again shortly or restart Orca if the issue continues.'

export type WslTranscriptFsFailureCode = 'timeout' | 'capacity' | 'unavailable'

export class WslTranscriptFsError extends Error {
  constructor(
    readonly code: WslTranscriptFsFailureCode,
    message: string
  ) {
    super(message)
    this.name = 'WslTranscriptFsError'
  }
}

export function wslTranscriptFsTimeoutError(): WslTranscriptFsError {
  return new WslTranscriptFsError('timeout', WSL_TRANSCRIPT_FS_SLOW_MESSAGE)
}

export function wslTranscriptFsCapacityError(): WslTranscriptFsError {
  return new WslTranscriptFsError('capacity', WSL_TRANSCRIPT_FS_CAPACITY_MESSAGE)
}

export function wslTranscriptFsUnavailableError(): WslTranscriptFsError {
  return new WslTranscriptFsError('unavailable', WSL_TRANSCRIPT_FS_SLOW_MESSAGE)
}

/** Narrow a caught error to a gate refusal, rethrowing anything else. */
export function wslTranscriptFsRefusal(error: unknown): WslTranscriptFsError {
  if (error instanceof WslTranscriptFsError) {
    return error
  }
  throw error
}
