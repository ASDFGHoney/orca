export type TranscriptFileStamp = {
  size: number
  identity: string
  identityReliable: boolean
  mtimeMs: number
  ctimeMs: number
}

export class TranscriptRangeReadInvalidatedError extends Error {
  constructor() {
    super('Transcript changed during remote read')
    this.name = 'TranscriptRangeReadInvalidatedError'
  }
}

export type TranscriptRangeFs = {
  stat(filePath: string, signal?: AbortSignal): Promise<TranscriptFileStamp>
  read(filePath: string, position: number, length: number, signal?: AbortSignal): Promise<Buffer>
  assertStable(
    filePath: string,
    openingStamp: TranscriptFileStamp,
    signal?: AbortSignal
  ): Promise<void>
}
