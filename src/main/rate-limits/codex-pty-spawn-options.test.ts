import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, ptySpawnMock, readFileMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  ptySpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))
vi.mock('../codex/codex-state-db', () => ({ isCodexStateDbBackfillPending: vi.fn(() => false) }))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startBackfillRecoveryInBackground: vi.fn(() => Promise.resolve(null))
}))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => Promise.resolve('present'))
}))

import { fetchCodexRateLimits } from './codex-fetcher'

function makePtyTerm() {
  let exitHandler: (() => void) | null = null
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((callback: () => void) => {
      exitHandler = callback
      return { dispose: vi.fn() }
    }),
    write: vi.fn(),
    kill: vi.fn(),
    emitExit: () => exitHandler?.()
  }
}

describe('Codex hidden PTY spawn options', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses bundled ConPTY on capable Windows builds', async () => {
    const term = makePtyTerm()
    ptySpawnMock.mockReturnValue(term)

    const result = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(0)

    if (process.platform === 'win32') {
      expect(ptySpawnMock.mock.calls[0]?.[2]).toMatchObject({ useConptyDll: true })
    } else {
      expect(ptySpawnMock.mock.calls[0]?.[2]).not.toHaveProperty('useConptyDll')
    }
    term.emitExit()
    await result
  })
})
