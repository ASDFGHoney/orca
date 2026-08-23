import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { createWslProcessGroupTermination } from './wsl-process-group-termination'

describe('WSL process-group termination', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue({ code: 0, timedOut: false })
  })

  it('wraps the guest command in a reported process group', () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const args = termination.wrapGuestArgs(['git', 'fetch'])

    expect(args.slice(0, 3)).toEqual(['setsid', '--wait', 'sh'])
    expect(args.slice(-2)).toEqual(['git', 'fetch'])
    expect(args.join(' ')).toContain('__ORCA_WSL_PROCESS_GROUP_')
  })

  it('forces and verifies the reported guest process group', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}43`))
    termination.observeStderr?.(Buffer.from('21\n'))

    await expect(termination.force({} as ChildProcess)).resolves.toBe(true)

    const spec = runProcessMock.mock.calls[0]?.[0]
    expect(spec.program).toBe('wsl.exe')
    expect(spec.args).toContain('4321')
    expect(spec.args.join(' ')).toContain('kill -KILL')
  })

  it('does not claim termination before the guest reports its identity', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')

    await expect(termination.signal({} as ChildProcess)).resolves.toBe(false)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('retains the guest identity from a large coalesced stderr chunk', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const wrapped = termination.wrapGuestArgs(['git', 'fetch']).join(' ')
    const marker = wrapped.match(/(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/)?.[1]
    termination.observeStderr?.(Buffer.from(`${marker}4321\n${'x'.repeat(1_024)}`))

    await expect(termination.signal({} as ChildProcess)).resolves.toBe(true)
    expect(runProcessMock.mock.calls[0]?.[0]?.args).toContain('4321')
  })
})
