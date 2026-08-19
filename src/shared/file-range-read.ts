/** Largest window one `fs.readFileRange` response may carry: `STREAM_CHUNK_SIZE`,
 *  the house per-frame budget for file bytes.
 *
 *  The binding constraint is the relay writer's admission budget, NOT the 16 MiB
 *  frame cap. A response frame over `DISPATCHER_CONTROL_QUEUE_MAX_BYTES` (1 MiB)
 *  is demoted to the `legacy-response` lane, which is refused once the producer
 *  queue passes `DEFAULT_PRODUCER_QUEUE_MAX_BYTES` (2 MiB) -- so a wide window
 *  fails with an opaque `ResponseOverCapacity` that depends on what else is
 *  queued at the time. 256 KiB of raw bytes is ~350 KB of base64, which stays in
 *  the control lane unconditionally. Bigger transfers belong on the ack-paced
 *  bulk lane (`fs.readFileStream`), not on a wider cap here.
 *
 *  Requests above it are REJECTED, never clamped: a clamped read is
 *  indistinguishable from EOF, and callers page by advancing `position`. */
export const MAX_FILE_RANGE_READ_BYTES = 256 * 1024

/** A range request the host will refuse. Separate from a read failure so a
 *  caller can tell "I asked for the wrong thing" from "the file is unreadable". */
export class FileRangeReadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileRangeReadRequestError'
  }
}

/** The single source of truth for what `fs.readFileRange` accepts. Both sides
 *  call it: the client so an invalid request never costs a round trip, the host
 *  because `position`/`length` land straight in an fd read and the relay has no
 *  request schema. Two independent copies would drift into a client that sends
 *  what the host rejects. */
export function validateFileRangeRequest(
  position: unknown,
  length: unknown
): { position: number; length: number } {
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
    throw new FileRangeReadRequestError(
      'fs.readFileRange requires a non-negative safe-integer position'
    )
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0) {
    throw new FileRangeReadRequestError('fs.readFileRange requires a positive integer length')
  }
  if (length > MAX_FILE_RANGE_READ_BYTES) {
    throw new FileRangeReadRequestError(
      `fs.readFileRange length ${length} exceeds the ${MAX_FILE_RANGE_READ_BYTES}-byte limit`
    )
  }
  return { position, length }
}
