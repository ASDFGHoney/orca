import { describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import { FileRangeReadUnsupportedError } from './filesystem-provider-contract'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

function methodNotFound(): Error {
  const err = new Error('Method not found: fs.readFileRange') as Error & { code?: number }
  err.code = -32601
  return err
}

function providerWith(request: ReturnType<typeof vi.fn>): SshFilesystemProvider {
  const mux = { request, onNotification: () => () => {} } as unknown as SshChannelMultiplexer
  return new SshFilesystemProvider('conn-1', mux)
}

describe('SshFilesystemProvider.readFileRange', () => {
  it('decodes the base64 window the relay returned', async () => {
    const payload = Buffer.from('hello')
    const request = vi.fn().mockResolvedValue({
      base64: payload.toString('base64'),
      bytesRead: payload.length
    })
    const result = await providerWith(request).readFileRange('/x.jsonl', 7, 5)
    expect(result.bytes).toEqual(payload)
    expect(result.bytesRead).toBe(5)
    expect(request).toHaveBeenCalledWith(
      'fs.readFileRange',
      { filePath: '/x.jsonl', position: 7, length: 5 },
      undefined
    )
  })

  // Throwing beats a whole-file fallback here: a tailing caller issues several
  // reads per snapshot, so falling back per call is quadratic on a growing file.
  it('throws a typed unsupported error against a relay without the method', async () => {
    const request = vi.fn().mockRejectedValue(methodNotFound())
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 4)).rejects.toBeInstanceOf(
      FileRangeReadUnsupportedError
    )
  })

  it('propagates a non-capability error unchanged', async () => {
    const request = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'))
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 4)).rejects.toThrow(/EACCES/)
  })

  // The remote is untrusted for framing: a count disagreeing with the payload
  // would shift every downstream offset while looking like a success.
  it('rejects a byte count that disagrees with the payload', async () => {
    const request = vi.fn().mockResolvedValue({
      base64: Buffer.from('ab').toString('base64'),
      bytesRead: 9
    })
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 10)).rejects.toThrow(
      /inconsistent byte count/
    )
  })

  it('rejects a byte count larger than the requested length', async () => {
    const payload = Buffer.from('abcdef')
    const request = vi.fn().mockResolvedValue({
      base64: payload.toString('base64'),
      bytesRead: payload.length
    })
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 2)).rejects.toThrow(
      /inconsistent byte count/
    )
  })

  it('rejects a malformed response', async () => {
    const request = vi.fn().mockResolvedValue({ bytesRead: 3 })
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 3)).rejects.toThrow(
      /malformed response/
    )
  })
})

describe('SshFilesystemProvider.supportsFileRangeRead', () => {
  it('is true when the relay advertises the capability', async () => {
    const request = vi.fn().mockResolvedValue({ rangedReadVersion: 1 })
    await expect(providerWith(request).supportsFileRangeRead()).resolves.toBe(true)
  })

  it('is false when the relay omits it', async () => {
    const request = vi.fn().mockResolvedValue({ quickOpenSearchVersion: 1 })
    await expect(providerWith(request).supportsFileRangeRead()).resolves.toBe(false)
  })

  it('is false when the relay predates fs.getCapabilities', async () => {
    const request = vi.fn().mockRejectedValue(methodNotFound())
    await expect(providerWith(request).supportsFileRangeRead()).resolves.toBe(false)
  })

  it('probes once per connection and caches the answer', async () => {
    const request = vi.fn().mockResolvedValue({ rangedReadVersion: 1 })
    const provider = providerWith(request)
    await provider.supportsFileRangeRead()
    await provider.supportsFileRangeRead()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
