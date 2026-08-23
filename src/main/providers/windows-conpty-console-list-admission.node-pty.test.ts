import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { afterAll, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process') as { fork: (...args: unknown[]) => FakeChild }
const originalFork = childProcess.fork

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> }

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.kill = vi.fn()
  return child
}

afterAll(() => {
  childProcess.fork = originalFork
})

describe('node-pty Windows console-list admission', () => {
  it('admits no replacement until the active helper closes', async () => {
    const children: FakeChild[] = []
    childProcess.fork = vi.fn(() => {
      const child = fakeChild()
      children.push(child)
      return child
    })
    const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent.js') as {
      WindowsPtyAgent: { prototype: object }
    }
    const read = Reflect.get(WindowsPtyAgent.prototype, '_getConsoleProcessList') as (this: {
      _innerPid: number
    }) => Promise<number[]>

    const reads = Array.from({ length: 32 }, (_, index) => read.call({ _innerPid: 4_242 + index }))
    expect(children).toHaveLength(1)
    children[0]!.emit('message', { consoleProcessList: [4_242, 9_999] })
    await expect(Promise.all(reads)).resolves.toHaveLength(32)

    await expect(read.call({ _innerPid: 5_000 })).resolves.toEqual([5_000])
    expect(children).toHaveLength(1)

    children[0]!.emit('close', 0, null)
    const replacement = read.call({ _innerPid: 6_000 })
    expect(children).toHaveLength(2)
    children[1]!.emit('error', new Error('spawn failed'))
    await expect(replacement).resolves.toEqual([6_000])
    children[1]!.emit('close', null, null)

    childProcess.fork = vi.fn(() => {
      throw new Error('fork unavailable')
    })
    await expect(read.call({ _innerPid: 7_000 })).resolves.toEqual([7_000])
  })

  it.runIf(process.platform === 'win32')(
    'bounds real stalled helper processes',
    async () => {
      const children: ReturnType<typeof originalFork>[] = []
      const exits: Promise<void>[] = []
      const fixture = require.resolve('./fixtures/conpty-console-list-stall.cjs')
      childProcess.fork = vi.fn(() => {
        const child = originalFork(fixture, { silent: true })
        children.push(child)
        exits.push(new Promise((resolve) => child.once('exit', () => resolve())))
        return child as FakeChild
      })
      const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent.js') as {
        WindowsPtyAgent: { prototype: object }
      }
      const read = Reflect.get(WindowsPtyAgent.prototype, '_getConsoleProcessList') as (this: {
        _innerPid: number
      }) => Promise<number[]>
      const reads = Array.from({ length: 32 }, (_, index) =>
        read.call({ _innerPid: 8_000 + index })
      )

      await new Promise((resolve) => setTimeout(resolve, 250))
      const live = children.filter((child) => child.pid && isProcessAlive(child.pid))
      console.log(
        JSON.stringify({
          parentPid: process.pid,
          helperPids: live.map(({ pid }) => pid),
          forkCount: children.length,
          osLiveProcessCount: live.length
        })
      )
      expect(children).toHaveLength(1)
      expect(live).toHaveLength(1)

      children[0]!.kill()
      await Promise.all([...reads, ...exits])
      expect(children.filter((child) => child.pid && isProcessAlive(child.pid))).toHaveLength(0)
    },
    10_000
  )
})

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
