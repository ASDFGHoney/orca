import type * as ChildProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'

// Module-level, so it intercepts the module's own import binding. A spyOn of a
// require()'d child_process does not: the first version of this test passed
// even with a fork() reintroduced, which is the failure it exists to catch.
const forkMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  fork: forkMock
}))

import { readWindowsConptyProcessIds } from './windows-conpty-process-membership'

const pty = (pid = 100): IPty => ({ pid }) as unknown as IPty

describe('readWindowsConptyProcessIds', () => {
  it('never spawns a child process to answer', () => {
    // The whole point. node-pty answers console membership by FORKING a helper,
    // and Orca asked on a foreground poll, per pane -- hundreds of hidden
    // conpty_console_list_agent processes until the machine ran out of memory
    // (#10857). Killing them changed nothing; the next poll spawned more.
    // QueryInformationJobObject needs no console attachment, so this is one
    // syscall and zero children.
    const listJobProcessIds = vi.fn(() => [100, 200])
    forkMock.mockClear()

    for (let read = 0; read < 50; read += 1) {
      readWindowsConptyProcessIds(pty(), { listJobProcessIds })
    }

    expect(forkMock).not.toHaveBeenCalled()
    expect(listJobProcessIds).toHaveBeenCalledTimes(50)
  })

  it('reports the shell alone, which is what lets a stale agent be retired', () => {
    const membership = readWindowsConptyProcessIds(pty(), { listJobProcessIds: () => [100] })

    expect(membership).toEqual(new Set([100]))
    expect(membership?.size).toBe(1)
  })

  it('reports descendants, which is what keeps a live agent cached', () => {
    const membership = readWindowsConptyProcessIds(pty(), {
      listJobProcessIds: () => [100, 200, 300]
    })

    expect(membership?.size).toBe(3)
  })

  it.each([
    ['no job support or an untracked tree', null],
    ['an empty job, which is not the shell-alone case', []]
  ])('reports unverifiable for %s', (_case, pids) => {
    // null is never evidence that processes died
    // (docs/reference/ssh-execution-boundary.md). An empty list means the tree
    // is gone, which this function has never been the one to report.
    expect(readWindowsConptyProcessIds(pty(), { listJobProcessIds: () => pids })).toBeNull()
  })

  it('drops nonsense pids rather than trusting the whole answer', () => {
    const membership = readWindowsConptyProcessIds(pty(), {
      listJobProcessIds: () => [100, 0, -1, 1.5, 200]
    })

    expect(membership).toEqual(new Set([100, 200]))
  })
})
