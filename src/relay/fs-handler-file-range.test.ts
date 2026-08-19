import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_RELAY_RANGE_READ_BYTES,
  RelayRangeTooLargeError,
  readRelayFileRange
} from './fs-handler-file-range'

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

  // Rejecting beats clamping: a clamped read is indistinguishable from EOF.
  it('rejects an over-cap request instead of silently clamping', async () => {
    const path = await fileWith('abc')
    await expect(
      readRelayFileRange(path, 0, MAX_RELAY_RANGE_READ_BYTES + 1)
    ).rejects.toBeInstanceOf(RelayRangeTooLargeError)
  })

  it('rejects a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-range-missing-'))
    roots.push(root)
    await expect(readRelayFileRange(join(root, 'nope.bin'), 0, 4)).rejects.toThrow()
  })
})
