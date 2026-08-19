import { open } from 'node:fs/promises'

/** Largest range one JSON-RPC response may carry. Requests above this are
 *  REJECTED rather than clamped: a silently shortened read is indistinguishable
 *  from EOF or a truncation, and callers page by advancing `position`. */
export const MAX_RELAY_RANGE_READ_BYTES = 4 * 1024 * 1024

export class RelayRangeTooLargeError extends Error {
  constructor(requested: number) {
    super(
      `Requested range of ${requested} bytes exceeds the ${MAX_RELAY_RANGE_READ_BYTES}-byte limit`
    )
    this.name = 'RelayRangeTooLargeError'
  }
}

/** Positional read for tailing an append-only file. Loops until `length` is
 *  satisfied or the file genuinely ends, so a short result always means EOF and
 *  never a partial syscall. Base64 because the payload is arbitrary bytes and
 *  may split a UTF-8 sequence at either edge. */
export async function readRelayFileRange(
  filePath: string,
  position: number,
  length: number
): Promise<{ base64: string; bytesRead: number }> {
  if (length > MAX_RELAY_RANGE_READ_BYTES) {
    throw new RelayRangeTooLargeError(length)
  }
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let total = 0
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, position + total)
      if (bytesRead <= 0) {
        break
      }
      total += bytesRead
    }
    return { base64: buffer.subarray(0, total).toString('base64'), bytesRead: total }
  } finally {
    await handle.close()
  }
}
