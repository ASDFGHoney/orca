import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'

type FenceAdapter = DaemonPtyAdapter & {
  emitExit: (id: string, code: number, incarnationId: string) => void
  emitIdentityChange: () => void
}

function createFenceAdapter(label: string, initialSessions: string[] = []): FenceAdapter {
  const sessions = [...initialSessions]
  let exitListener: ((event: { id: string; code: number; incarnationId?: string }) => void) | null =
    null
  let identityChangeListener: (() => void) | null = null
  const noopSubscription = vi.fn(() => () => {})
  return {
    spawn: vi.fn(async (options: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = options.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id, incarnationId: `${label}:${id}` }
    }),
    listProcesses: vi.fn(async () =>
      sessions.map((id) => ({ id, incarnationId: `${label}:${id}`, cwd: '', title: label }))
    ),
    write: vi.fn(),
    shutdown: vi.fn(),
    onData: noopSubscription,
    onBackgroundStreamEvent: noopSubscription,
    onWriteUnavailable: noopSubscription,
    onExit: vi.fn((listener) => {
      exitListener = listener
      return () => {
        exitListener = null
      }
    }),
    onDaemonIdentityChanged: vi.fn((listener) => {
      identityChangeListener = listener
      return () => {
        identityChangeListener = null
      }
    }),
    emitExit: (id, code, incarnationId) => exitListener?.({ id, code, incarnationId }),
    emitIdentityChange: () => identityChangeListener?.()
  } as unknown as FenceAdapter
}

describe('DaemonPtyRouter owner fencing', () => {
  it('keeps replacement B routed after a delayed exit from owner A', async () => {
    const current = createFenceAdapter('current')
    const legacy = createFenceAdapter('legacy', ['reused-session'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    legacy.emitIdentityChange()
    await router.spawn({ cols: 80, rows: 24, sessionId: 'reused-session' })
    const routes = (router as unknown as { sessionAdapters: Map<string, DaemonPtyAdapter> })
      .sessionAdapters
    expect(routes.get('reused-session')).toBe(current)

    legacy.emitExit('reused-session', 0, 'legacy:reused-session')
    expect(routes.get('reused-session')).toBe(current)
    router.write('reused-session', 'replacement-marker')

    expect(current.write).toHaveBeenCalledWith('reused-session', 'replacement-marker')
    expect(legacy.write).not.toHaveBeenCalled()
    expect(current.shutdown).not.toHaveBeenCalled()
  })
})
