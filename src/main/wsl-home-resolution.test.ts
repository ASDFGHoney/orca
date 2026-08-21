import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock
  }
})

import { _resetWslCachesForTests, getWslHome, resolveWslHome } from './wsl'

describe('resolveWslHome', () => {
  afterEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('classifies a wsl.exe failure as unavailable rather than a missing home', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('timeout'), { status: 1 })
    })

    expect(resolveWslHome('Ubuntu')).toEqual({
      kind: 'unavailable',
      error: expect.objectContaining({ message: 'timeout' })
    })
    expect(getWslHome('Ubuntu')).toBeNull()
  })

  it('classifies an empty or relative $HOME as invalid', () => {
    execFileSyncMock.mockReturnValue('not-a-home\n')

    expect(resolveWslHome('Ubuntu')).toEqual({ kind: 'invalid' })
    expect(getWslHome('Ubuntu')).toBeNull()
  })

  it('resolves and caches a valid $HOME as a Windows UNC path', () => {
    execFileSyncMock.mockReturnValue('/home/alice\n')

    expect(resolveWslHome('Ubuntu')).toEqual({
      kind: 'resolved',
      uncPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice'
    })
    expect(getWslHome('Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\alice')
    expect(resolveWslHome('Ubuntu')).toEqual({
      kind: 'resolved',
      uncPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice'
    })
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
  })
})
