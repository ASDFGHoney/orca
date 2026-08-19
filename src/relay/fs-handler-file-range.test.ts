import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRelayFileRange } from './fs-handler-file-range'
import { FileRangeReadRequestError, MAX_FILE_RANGE_READ_BYTES } from '../shared/file-range-read'
import { HEADER_LENGTH, prepareJsonRpcPayload } from './protocol'
import { DISPATCHER_CONTROL_QUEUE_MAX_BYTES } from './dispatcher-writer-admission'

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

async function fileWith(contents: Buffer | string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-range-'))
  roots.push(root)
  const path = join(root, 'data.bin')
  await writeFile(path, contents)
  return path
}

function decode(base64: string): Buffer {
  return Buffer.from(base64, 'base64')
}

describe('readRelayFileRange', () => {
  it('returns exactly the requested window', async () => {
    const path = await fileWith('0123456789')
    const result = await readRelayFileRange(path, 3, 4)
    expect(decode(result.base64).toString('utf8')).toBe('3456')
    expect(result.bytesRead).toBe(4)
  })

  it('reads from a non-zero position to the end', async () => {
    const path = await fileWith('abcdef')
    const result = await readRelayFileRange(path, 4, 2)
    expect(decode(result.base64).toString('utf8')).toBe('ef')
  })

  // A short result must mean EOF and nothing else, or a caller advancing a
  // cursor by bytesRead would silently skip data.
  it('short-reads only at end of file', async () => {
    const path = await fileWith('abc')
    const result = await readRelayFileRange(path, 1, 100)
    expect(result.bytesRead).toBe(2)
    expect(decode(result.base64).toString('utf8')).toBe('bc')
  })

  it('returns zero bytes when the position is past the end', async () => {
    const path = await fileWith('abc')
    const result = await readRelayFileRange(path, 99, 10)
    expect(result.bytesRead).toBe(0)
    expect(decode(result.base64)).toHaveLength(0)
  })

  it('returns zero bytes when the position is exactly at the end', async () => {
    const path = await fileWith('abc')
    const result = await readRelayFileRange(path, 3, 10)
    expect(result.bytesRead).toBe(0)
  })

  // The window is one fixed allocation filled across however many syscalls the
  // kernel takes, so every partial read has to land at the right offset in it.
  it('assembles a many-page window without misplacing any byte', async () => {
    const size = MAX_FILE_RANGE_READ_BYTES
    const contents = Buffer.allocUnsafe(size)
    for (let i = 0; i < size; i++) {
      contents[i] = i % 251
    }
    const path = await fileWith(contents)
    const result = await readRelayFileRange(path, 1024, size - 1024)
    expect(result.bytesRead).toBe(size - 1024)
    // .equals(), not toEqual(): a byte-wise diff of a 256 KiB buffer costs
    // minutes when it passes.
    expect(decode(result.base64).equals(contents.subarray(1024))).toBe(true)
  })

  // Base64 rather than utf-8: a range boundary can split a multi-byte sequence,
  // and a utf-8 round trip would substitute U+FFFD and shift every later offset.
  it('preserves bytes that split a multi-byte character at both edges', async () => {
    const text = Buffer.from('aé漢b', 'utf8')
    const path = await fileWith(text)
    const middle = await readRelayFileRange(path, 1, 3)
    expect(decode(middle.base64)).toEqual(text.subarray(1, 4))
  })

  it('round-trips arbitrary binary bytes', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x80, 0x7f])
    const path = await fileWith(bytes)
    const result = await readRelayFileRange(path, 0, bytes.length)
    expect(decode(result.base64)).toEqual(bytes)
  })

  // The cap is a TRANSPORT budget, not just a memory one. A response frame over
  // DISPATCHER_CONTROL_QUEUE_MAX_BYTES is demoted to the `legacy-response` lane,
  // which the writer refuses once the producer queue is busy -- so an over-wide
  // cap fails with ResponseOverCapacity depending on unrelated load. A full-cap
  // window of incompressible bytes must stay inside the control lane.
  it('encodes a full-cap window into a frame the control lane always admits', async () => {
    const contents = Buffer.allocUnsafe(MAX_FILE_RANGE_READ_BYTES)
    for (let i = 0; i < contents.length; i++) {
      contents[i] = (i * 37) % 256
    }
    const path = await fileWith(contents)
    const result = await readRelayFileRange(path, 0, MAX_FILE_RANGE_READ_BYTES)
    expect(result.bytesRead).toBe(MAX_FILE_RANGE_READ_BYTES)
    const frameBytes =
      HEADER_LENGTH + prepareJsonRpcPayload({ jsonrpc: '2.0', id: 4294967295, result }).byteLength
    expect(frameBytes).toBeLessThanOrEqual(DISPATCHER_CONTROL_QUEUE_MAX_BYTES)
  })

  it('rejects a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-range-missing-'))
    roots.push(root)
    await expect(readRelayFileRange(join(root, 'nope.bin'), 0, 4)).rejects.toThrow()
  })

  // Every rejection below happens before the file is opened: these offsets go
  // straight into a read syscall and the relay has no request schema.
  describe('request validation', () => {
    // Rejecting beats clamping: a clamped read is indistinguishable from EOF.
    it('rejects an over-cap length instead of silently clamping', async () => {
      const path = await fileWith('abc')
      await expect(
        readRelayFileRange(path, 0, MAX_FILE_RANGE_READ_BYTES + 1)
      ).rejects.toBeInstanceOf(FileRangeReadRequestError)
    })

    it('accepts a length exactly at the cap', async () => {
      const path = await fileWith('abc')
      const result = await readRelayFileRange(path, 0, MAX_FILE_RANGE_READ_BYTES)
      expect(result.bytesRead).toBe(3)
    })

    it.each([
      ['a negative position', -1, 4],
      ['a fractional position', 1.5, 4],
      ['a NaN position', Number.NaN, 4],
      ['an infinite position', Number.POSITIVE_INFINITY, 4],
      ['a position past the safe-integer range', Number.MAX_SAFE_INTEGER + 2, 4],
      ['a zero length', 0, 0],
      ['a negative length', 0, -4],
      ['a fractional length', 0, 4.5],
      ['a NaN length', 0, Number.NaN]
    ])('rejects %s', async (_label, position, length) => {
      const path = await fileWith('abc')
      await expect(readRelayFileRange(path, position, length)).rejects.toBeInstanceOf(
        FileRangeReadRequestError
      )
    })

    it.each([
      ['a missing position', undefined, 4],
      ['a string position', '0', 4],
      ['a missing length', 0, undefined],
      ['a string length', 0, '4']
    ])('rejects %s from an unschema-d param bag', async (_label, position, length) => {
      const path = await fileWith('abc')
      await expect(readRelayFileRange(path, position, length)).rejects.toBeInstanceOf(
        FileRangeReadRequestError
      )
    })
  })
})
