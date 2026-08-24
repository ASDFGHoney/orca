import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyProcessLivenessBroker } from './pty-process-liveness-broker'

afterEach(() => {
  vi.useRealTimers()
})

describe('PtyProcessLivenessBroker', () => {
  it('bounds a hanging probe and does not fan out another unresolved inspection', async () => {
    vi.useFakeTimers()
    let resolveInspection!: (value: {
      foregroundProcess: string | null
      hasChildProcesses: boolean
    }) => void
    const inspection = new Promise<{
      foregroundProcess: string | null
      hasChildProcesses: boolean
    }>((resolve) => {
      resolveInspection = resolve
    })
    const inspectProcess = vi.fn(() => inspection)
    const source = {
      getForegroundProcess: vi.fn(async () => null),
      inspectProcess
    }
    const broker = new PtyProcessLivenessBroker({ timeoutMs: 100 })

    const first = broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(first).resolves.toEqual({
      status: 'unverifiable',
      reason: 'process inspection timed out'
    })
    await expect(
      broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    ).resolves.toEqual({ status: 'unverifiable', reason: 'process inspection timed out' })
    expect(inspectProcess).toHaveBeenCalledOnce()

    resolveInspection({ foregroundProcess: 'codex', hasChildProcesses: true })
    await vi.runAllTimersAsync()
    await expect(
      broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    ).resolves.toEqual({
      status: 'live',
      foregroundProcess: 'codex',
      hasChildProcesses: true
    })
    expect(inspectProcess).toHaveBeenCalledOnce()
  })

  it('caches live evidence across sequential clients', async () => {
    const inspectProcess = vi.fn(async () => ({
      foregroundProcess: 'codex',
      hasChildProcesses: true
    }))
    const source = {
      getForegroundProcess: vi.fn(async () => null),
      inspectProcess
    }
    const broker = new PtyProcessLivenessBroker({ timeoutMs: 100 })

    await broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    await broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })

    expect(inspectProcess).toHaveBeenCalledOnce()
  })

  it('treats only exact terminal_gone evidence as exited', async () => {
    const gone = vi.fn(async () => {
      throw new Error('terminal_gone')
    })
    const unavailable = vi.fn(async () => {
      throw new Error('socket_closed')
    })
    const onInspectionError = vi.fn()
    const broker = new PtyProcessLivenessBroker({ timeoutMs: 100, onInspectionError })

    await expect(
      broker.inspect({
        source: { getForegroundProcess: vi.fn(async () => null), inspectProcess: gone },
        ptyId: 'pty-gone',
        identity: 'incarnation-a'
      })
    ).resolves.toEqual({ status: 'exited' })
    await expect(
      broker.inspect({
        source: { getForegroundProcess: vi.fn(async () => null), inspectProcess: unavailable },
        ptyId: 'pty-unavailable',
        identity: 'incarnation-b'
      })
    ).resolves.toEqual({ status: 'unverifiable', reason: 'socket_closed' })
    expect(onInspectionError).toHaveBeenCalledExactlyOnceWith(
      'pty-unavailable',
      expect.objectContaining({ message: 'socket_closed' })
    )
  })

  it('does not let an old incarnation populate the replacement cache entry', async () => {
    let resolveOld!: (value: { foregroundProcess: string; hasChildProcesses: boolean }) => void
    const oldInspection = new Promise<{
      foregroundProcess: string
      hasChildProcesses: boolean
    }>((resolve) => {
      resolveOld = resolve
    })
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(oldInspection)
      .mockResolvedValueOnce({ foregroundProcess: 'zsh', hasChildProcesses: false })
    const source = {
      getForegroundProcess: vi.fn(async () => null),
      inspectProcess
    }
    const broker = new PtyProcessLivenessBroker({ timeoutMs: 1_000 })

    const oldRead = broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    const replacementRead = broker.inspect({
      source,
      ptyId: 'pty-1',
      identity: 'incarnation-b'
    })
    resolveOld({ foregroundProcess: 'codex', hasChildProcesses: true })

    await expect(oldRead).resolves.toMatchObject({ status: 'live', foregroundProcess: 'codex' })
    await expect(replacementRead).resolves.toMatchObject({
      status: 'live',
      foregroundProcess: 'zsh'
    })
    await expect(
      broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-b' })
    ).resolves.toMatchObject({ status: 'live', foregroundProcess: 'zsh' })
    expect(inspectProcess).toHaveBeenCalledTimes(2)
  })

  it('does not replay cached absence after owning inventory re-observes the PTY', async () => {
    let now = 0
    const inspectProcess = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_gone'))
      .mockRejectedValueOnce(new Error('socket_closed'))
    const source = { getForegroundProcess: vi.fn(async () => null), inspectProcess }
    const broker = new PtyProcessLivenessBroker({
      timeoutMs: 100,
      unavailableBackoffBaseMs: 100,
      now: () => now
    })

    await expect(
      broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    ).resolves.toEqual({ status: 'exited' })
    await expect(
      broker.inspect({
        source,
        ptyId: 'pty-1',
        identity: 'incarnation-a',
        owningInventoryObservedPty: true
      })
    ).resolves.toMatchObject({ status: 'unverifiable' })
    now = 201
    await expect(
      broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    ).resolves.toEqual({ status: 'unverifiable', reason: 'socket_closed' })
  })

  it('lets completion-sensitive readers await a shared probe past the catalog timeout', async () => {
    vi.useFakeTimers()
    let resolveInspection!: (value: {
      foregroundProcess: string
      hasChildProcesses: boolean
    }) => void
    const inspection = new Promise<{ foregroundProcess: string; hasChildProcesses: boolean }>(
      (resolve) => {
        resolveInspection = resolve
      }
    )
    const source = {
      getForegroundProcess: vi.fn(async () => null),
      inspectProcess: vi.fn(() => inspection)
    }
    const broker = new PtyProcessLivenessBroker({ timeoutMs: 100 })

    const catalog = broker.inspect({ source, ptyId: 'pty-1', identity: 'incarnation-a' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(catalog).resolves.toMatchObject({ status: 'unverifiable' })
    const completion = broker.inspect({
      source,
      ptyId: 'pty-1',
      identity: 'incarnation-a',
      waitForSettlement: true,
      reuseSettled: false
    })
    let settled = false
    void completion.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)

    resolveInspection({ foregroundProcess: 'codex', hasChildProcesses: true })
    await expect(completion).resolves.toMatchObject({ status: 'live', foregroundProcess: 'codex' })
  })

  it('contains failures from diagnostic observers', async () => {
    const broker = new PtyProcessLivenessBroker({
      timeoutMs: 100,
      onInspectionError: () => {
        throw new Error('logger failed')
      }
    })

    await expect(
      broker.inspect({
        source: {
          getForegroundProcess: vi.fn(async () => null),
          inspectProcess: vi.fn(async () => {
            throw new Error('socket_closed')
          })
        },
        ptyId: 'pty-1',
        identity: 'incarnation-a'
      })
    ).resolves.toEqual({ status: 'unverifiable', reason: 'socket_closed' })
  })
})
