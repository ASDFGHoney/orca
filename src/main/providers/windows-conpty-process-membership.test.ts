import type { ChildProcess, fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsConptyProcessMembershipReader } from './windows-conpty-process-membership'

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>
  pid?: number
  spawnargs: string[]
}

function fakeChild(pid?: number, exitOnKill = true): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.spawnargs = []
  child.kill = vi.fn(() => {
    if (exitOnKill) {
      queueMicrotask(() => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
    }
    return true
  })
  return child
}

function readerWith(children: FakeChild[], timeoutMs = 100) {
  const forkProcess = vi.fn(() => {
    const child = children.shift()
    if (!child) {
      throw new Error('unexpected fork')
    }
    return child as unknown as ChildProcess
  }) as unknown as typeof fork
  const reader = new WindowsConptyProcessMembershipReader({
    forkProcess,
    resolveAgentPath: () => 'C:\\fixed\\node-pty\\conpty_console_list_agent.js',
    timeoutMs
  })
  return { forkProcess: vi.mocked(forkProcess), reader }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WindowsConptyProcessMembershipReader', () => {
  it('returns normalized console membership and terminates the one-shot helper', async () => {
    const child = fakeChild(999)
    const { forkProcess, reader } = readerWith([child])
    const result = reader.read(101)

    child.emit('message', { consoleProcessList: [999, 101, 202, 303] })

    await expect(result).resolves.toEqual(new Set([101, 202, 303]))
    expect(forkProcess).toHaveBeenCalledWith(
      'C:\\fixed\\node-pty\\conpty_console_list_agent.js',
      ['101'],
      { silent: true }
    )
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent reads for one PTY root', async () => {
    const child = fakeChild(999)
    const { forkProcess, reader } = readerWith([child])
    const first = reader.read(101)
    const second = reader.read(101)

    expect(second).toBe(first)
    expect(forkProcess).toHaveBeenCalledTimes(1)
    child.emit('message', { consoleProcessList: [999, 101, 202] })

    await expect(Promise.all([first, second])).resolves.toEqual([
      new Set([101, 202]),
      new Set([101, 202])
    ])
  })

  it('waits for helper close before admitting a different root', async () => {
    const firstChild = fakeChild(901, false)
    const secondChild = fakeChild(902)
    const { forkProcess, reader } = readerWith([firstChild, secondChild])
    const first = reader.read(101)
    const second = reader.read(202)

    firstChild.emit('message', { consoleProcessList: [901, 101] })
    await expect(first).resolves.toEqual(new Set([101]))
    expect(forkProcess).toHaveBeenCalledTimes(1)

    firstChild.emit('exit', 0, null)
    expect(forkProcess).toHaveBeenCalledTimes(1)
    firstChild.emit('close', 0, null)
    expect(forkProcess).toHaveBeenCalledTimes(2)
    secondChild.emit('message', { consoleProcessList: [902, 202] })
    await expect(second).resolves.toEqual(new Set([202]))
  })

  it('does not reuse a settled result before the prior helper closes', async () => {
    const firstChild = fakeChild(901, false)
    const secondChild = fakeChild(902)
    const { forkProcess, reader } = readerWith([firstChild, secondChild])
    const first = reader.read(101)

    firstChild.emit('message', { consoleProcessList: [901, 101, 303] })
    await expect(first).resolves.toEqual(new Set([101, 303]))
    const second = reader.read(101)
    expect(forkProcess).toHaveBeenCalledTimes(1)

    firstChild.emit('close', 0, null)
    expect(forkProcess).toHaveBeenCalledTimes(2)
    secondChild.emit('message', { consoleProcessList: [902, 101, 404] })
    await expect(second).resolves.toEqual(new Set([101, 404]))
  })

  it('admits at most one helper when concurrent roots stall', async () => {
    vi.useFakeTimers()
    const child = fakeChild(999, false)
    const { forkProcess, reader } = readerWith([child], 10)
    const reads = Array.from({ length: 32 }, (_, index) => reader.read(100 + index))

    expect(forkProcess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10)

    await expect(Promise.all(reads)).resolves.toEqual(Array.from({ length: 32 }, () => null))
    expect(forkProcess).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledTimes(1)
    reader.dispose()
  })

  it('bounds pending distinct roots and load-sheds excess work', async () => {
    const child = fakeChild(999, false)
    const { forkProcess, reader } = readerWith([child])
    const active = reader.read(101)
    const queued = reader.read(202)

    await expect(reader.read(303)).resolves.toBeNull()
    expect(forkProcess).toHaveBeenCalledTimes(1)
    reader.dispose()
    await expect(Promise.all([active, queued])).resolves.toEqual([null, null])
  })

  it('does not replace a helper that failed to terminate', async () => {
    vi.useFakeTimers()
    const child = fakeChild(999, false)
    const { forkProcess, reader } = readerWith([child], 10)

    const first = reader.read(101)
    await vi.advanceTimersByTimeAsync(10)
    await expect(first).resolves.toBeNull()
    const second = reader.read(202)
    await vi.advanceTimersByTimeAsync(10)

    await expect(second).resolves.toBeNull()
    expect(forkProcess).toHaveBeenCalledTimes(1)
    reader.dispose()
  })

  it('drops an expired queued root without spawning it later', async () => {
    vi.useFakeTimers()
    const child = fakeChild(999, false)
    const { forkProcess, reader } = readerWith([child], 10)
    const active = reader.read(101)
    const queued = reader.read(202)

    await vi.advanceTimersByTimeAsync(10)
    await expect(Promise.all([active, queued])).resolves.toEqual([null, null])
    child.emit('close', 0, null)

    expect(forkProcess).toHaveBeenCalledTimes(1)
  })

  it('does not admit a staggered queued root after the active deadline', async () => {
    vi.useFakeTimers()
    const child = fakeChild(999)
    const { forkProcess, reader } = readerWith([child], 10)
    const active = reader.read(101)
    await vi.advanceTimersByTimeAsync(5)
    const queued = reader.read(202)

    await vi.advanceTimersByTimeAsync(5)

    await expect(Promise.all([active, queued])).resolves.toEqual([null, null])
    expect(forkProcess).toHaveBeenCalledTimes(1)
  })

  it('disposal settles active and queued reads without admitting another helper', async () => {
    const child = fakeChild(999, false)
    const { forkProcess, reader } = readerWith([child])
    const active = reader.read(101)
    const queued = reader.read(202)

    reader.dispose()

    await expect(Promise.all([active, queued])).resolves.toEqual([null, null])
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(forkProcess).toHaveBeenCalledTimes(1)
    await expect(reader.read(303)).resolves.toBeNull()
  })

  it('fails closed when the helper cannot spawn', async () => {
    const { forkProcess, reader } = readerWith([])

    await expect(reader.read(101)).resolves.toBeNull()
    expect(forkProcess).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid roots without spawning', async () => {
    const { forkProcess, reader } = readerWith([])

    await expect(reader.read(0)).resolves.toBeNull()
    expect(forkProcess).not.toHaveBeenCalled()
  })

  it.each([
    ['root-only fallback', [101], 999],
    ['malformed response', [999, 101, '202'], 999],
    ['missing PTY root', [999, 202, 303], 999],
    ['missing helper pid', [101, 202], 999],
    ['unavailable helper pid', [101, 202], undefined]
  ])('fails closed for %s', async (_label, processIds, helperPid) => {
    const child = fakeChild(helperPid)
    const { reader } = readerWith([child])
    const result = reader.read(101)

    child.emit('message', { consoleProcessList: processIds })

    await expect(result).resolves.toBeNull()
  })

  it('absorbs an asynchronous kill error after timeout settlement', async () => {
    vi.useFakeTimers()
    const child = fakeChild(999, false)
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('kill failed')))
      return false
    })
    const { reader } = readerWith([child], 10)
    const result = reader.read(101)

    await vi.advanceTimersByTimeAsync(10)

    await expect(result).resolves.toBeNull()
    expect(child.kill).toHaveBeenCalledTimes(1)
    reader.dispose()
  })

  it('releases an asynchronous spawn failure only after close', async () => {
    const failedChild = fakeChild(undefined, false)
    const healthyChild = fakeChild(902)
    const { forkProcess, reader } = readerWith([failedChild, healthyChild])
    const first = reader.read(101)

    failedChild.emit('error', new Error('spawn failed'))
    await expect(first).resolves.toBeNull()
    const second = reader.read(202)
    expect(forkProcess).toHaveBeenCalledTimes(1)

    failedChild.emit('close', null, null)
    expect(forkProcess).toHaveBeenCalledTimes(2)
    healthyChild.emit('message', { consoleProcessList: [902, 202] })
    await expect(second).resolves.toEqual(new Set([202]))
  })

  it('does not single-flight reused PIDs across PTY owners', async () => {
    const firstChild = fakeChild(901, false)
    const secondChild = fakeChild(902)
    const { forkProcess, reader } = readerWith([firstChild, secondChild])
    const firstOwner = {}
    const secondOwner = {}
    const first = reader.read(101, firstOwner)
    const second = reader.read(101, secondOwner)

    expect(second).not.toBe(first)
    firstChild.emit('message', { consoleProcessList: [901, 101, 303] })
    await expect(first).resolves.toEqual(new Set([101, 303]))
    firstChild.emit('close', 0, null)
    expect(forkProcess).toHaveBeenCalledTimes(2)
    secondChild.emit('message', { consoleProcessList: [902, 101, 404] })
    await expect(second).resolves.toEqual(new Set([101, 404]))
  })
})
