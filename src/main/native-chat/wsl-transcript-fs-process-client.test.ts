import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS,
  WslTranscriptFsProcessClient
} from './wsl-transcript-fs-process-client'
import { resolveWslTranscriptFsProcessEntryPath } from './wsl-transcript-fs-process-spawn'
import type {
  WslTranscriptFsProcessRequest,
  WslTranscriptFsProcessResponse
} from './wsl-transcript-fs-process-protocol'

class FakeProcess extends EventEmitter {
  readonly sent: WslTranscriptFsProcessRequest[] = []
  readonly kill = vi.fn(() => true)
  readonly unref = vi.fn()
  readonly channel = { unref: vi.fn() }

  send(message: WslTranscriptFsProcessRequest, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  respond(response: WslTranscriptFsProcessResponse): void {
    this.emit('message', response)
  }
}

function fakeChild(process: FakeProcess): ChildProcess {
  return process as unknown as ChildProcess
}

describe('WSL transcript filesystem process client', () => {
  it('reuses a healthy process for sequential operations', async () => {
    const child = new FakeProcess()
    const factory = vi.fn(() => fakeChild(child))
    const client = new WslTranscriptFsProcessClient(factory)

    const first = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\one' },
      new AbortController().signal
    )
    child.respond({ id: child.sent[0].id, ok: true, value: true })
    await expect(first).resolves.toBe(true)

    const second = client.run<string>(
      {
        operation: 'readfile',
        path: '\\\\wsl.localhost\\Ubuntu\\two',
        encoding: 'utf8'
      },
      new AbortController().signal
    )
    child.respond({ id: child.sent[1].id, ok: true, value: 'body' })

    await expect(second).resolves.toBe('body')
    expect(factory).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    client.dispose()
  })

  it('kills an aborted process and uses a replacement for later work', async () => {
    const firstChild = new FakeProcess()
    const replacement = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(firstChild))
      .mockReturnValueOnce(fakeChild(replacement))
    const client = new WslTranscriptFsProcessClient(factory)
    const controller = new AbortController()
    const reason = new Error('deadline expired')

    const stalled = client.run(
      { operation: 'stat', path: '\\\\wsl.localhost\\Ubuntu\\stalled' },
      controller.signal
    )
    controller.abort(reason)

    await expect(stalled).rejects.toBe(reason)
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')

    const later = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\later' },
      new AbortController().signal
    )
    replacement.respond({ id: replacement.sent[0].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    client.dispose()
  })

  it('pins reads to the process that owns the opened handle until close', async () => {
    const owner = new FakeProcess()
    const reusable = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(owner))
      .mockReturnValueOnce(fakeChild(reusable))
    const client = new WslTranscriptFsProcessClient(factory)
    const signal = new AbortController().signal

    const opening = client.open('\\\\wsl.localhost\\Ubuntu\\transcript', signal)
    owner.respond({ id: owner.sent[0].id, ok: true, value: 41 })
    const handle = await opening

    const unrelated = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\healthy' },
      signal
    )
    reusable.respond({ id: reusable.sent[0].id, ok: true, value: true })
    await expect(unrelated).resolves.toBe(true)

    const reading = client.read(handle, 8, 4, signal)
    expect(owner.sent[1]).toMatchObject({ operation: 'read', handleId: 41, position: 8 })
    owner.respond({ id: owner.sent[1].id, ok: true, value: Buffer.from('old!') })
    await expect(reading).resolves.toEqual(Buffer.from('old!'))

    const closing = client.close(handle)
    expect(owner.sent[2]).toMatchObject({ operation: 'close', handleId: 41 })
    owner.respond({ id: owner.sent[2].id, ok: true, value: true })
    await expect(closing).resolves.toBeUndefined()

    const later = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\later' },
      signal
    )
    owner.respond({ id: owner.sent[3].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    client.dispose()
  })

  it('invalidates only the handle whose read process is aborted', async () => {
    const owner = new FakeProcess()
    const healthy = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(owner))
      .mockReturnValueOnce(fakeChild(healthy))
    const client = new WslTranscriptFsProcessClient(factory)
    const opening = client.open(
      '\\\\wsl.localhost\\Ubuntu\\transcript',
      new AbortController().signal
    )
    owner.respond({ id: owner.sent[0].id, ok: true, value: 9 })
    const handle = await opening
    const controller = new AbortController()
    const reason = new Error('read deadline')

    const stalled = client.read(handle, 0, 1, controller.signal)
    const other = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\healthy' },
      new AbortController().signal
    )
    healthy.respond({ id: healthy.sent[0].id, ok: true, value: true })
    await expect(other).resolves.toBe(true)
    controller.abort(reason)

    await expect(stalled).rejects.toBe(reason)
    await expect(client.read(handle, 0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'EBADF'
    })
    expect(owner.kill).toHaveBeenCalledWith('SIGKILL')
    expect(healthy.kill).not.toHaveBeenCalled()

    const later = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\later' },
      new AbortController().signal
    )
    healthy.respond({ id: healthy.sent[1].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    client.dispose()
  })

  it('retires a process whose handle close does not settle', async () => {
    vi.useFakeTimers()
    const owner = new FakeProcess()
    const healthy = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(owner))
      .mockReturnValueOnce(fakeChild(healthy))
    const client = new WslTranscriptFsProcessClient(factory)
    try {
      const opening = client.open(
        '\\\\wsl.localhost\\Ubuntu\\transcript',
        new AbortController().signal
      )
      owner.respond({ id: owner.sent[0].id, ok: true, value: 12 })
      const handle = await opening
      const closing = client.close(handle)
      const closeFailure = expect(closing).rejects.toThrow('close timed out')

      const unrelated = client.run<boolean>(
        { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\healthy' },
        new AbortController().signal
      )
      healthy.respond({ id: healthy.sent[0].id, ok: true, value: true })
      await expect(unrelated).resolves.toBe(true)

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS)
      await closeFailure
      expect(owner.kill).toHaveBeenCalledWith('SIGKILL')
      expect(healthy.kill).not.toHaveBeenCalled()
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('reconstructs filesystem errors with their Node error code', async () => {
    const child = new FakeProcess()
    const client = new WslTranscriptFsProcessClient(() => fakeChild(child))
    const pending = client.run(
      { operation: 'stat', path: '\\\\wsl.localhost\\Ubuntu\\missing' },
      new AbortController().signal
    )

    child.respond({
      id: child.sent[0].id,
      ok: false,
      error: {
        name: 'Error',
        message: 'not found',
        code: 'ENOENT',
        syscall: 'stat',
        path: '\\\\wsl.localhost\\Ubuntu\\missing'
      }
    })

    await expect(pending).rejects.toMatchObject({
      message: 'not found',
      code: 'ENOENT',
      syscall: 'stat'
    })
    client.dispose()
  })

  it('restores Stats and Dirent methods after IPC serialization', async () => {
    const child = new FakeProcess()
    const client = new WslTranscriptFsProcessClient(() => fakeChild(child))
    const stats = client.run<Stats>(
      { operation: 'stat', path: '\\\\wsl.localhost\\Ubuntu\\file' },
      new AbortController().signal
    )
    child.respond({
      id: child.sent[0].id,
      ok: true,
      value: { mode: 0o100644, size: 12, mtime: new Date(0) }
    })

    expect((await stats).isFile()).toBe(true)

    const entries = client.run<Dirent[]>(
      { operation: 'readdir', path: '\\\\wsl.localhost\\Ubuntu\\dir' },
      new AbortController().signal
    )
    child.respond({
      id: child.sent[1].id,
      ok: true,
      value: [
        {
          name: 'child',
          parentPath: '\\\\wsl.localhost\\Ubuntu\\dir',
          isBlockDevice: false,
          isCharacterDevice: false,
          isDirectory: false,
          isFIFO: false,
          isFile: true,
          isSocket: false,
          isSymbolicLink: false
        }
      ]
    })

    expect((await entries)[0].isFile()).toBe(true)
    client.dispose()
  })
})

describe('WSL transcript filesystem process entry resolution', () => {
  it('prefers the unpacked sibling for a packaged main bundle', () => {
    const exists = vi.fn((path: string) => path.includes('app.asar.unpacked'))
    const moduleDir = join('root', 'resources', 'app.asar', 'out', 'main')

    expect(
      resolveWslTranscriptFsProcessEntryPath(moduleDir, join('root', 'resources'), exists)
    ).toBe(
      join(moduleDir.replace('app.asar', 'app.asar.unpacked'), 'wsl-transcript-fs-process-entry.js')
    )
  })
})
