import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  openStreamAndConfirmReady,
  settle
} from './remote-browser-stream-lifecycle-test-harness'

describe('RemoteBrowserStreamLifecycle first frame', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for visible proof and nudges one first frame from an old host', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()

    harness.streams[0].emitReady()
    await settle()

    expect(harness.currentStatusKind).toBe('opening')
    expect(harness.handledFrames).toBe(0)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(harness.rpcLog.filter((method) => method === 'browser.eval')).toHaveLength(1)

    harness.streams[0].emitFrame()
    await settle()

    expect(harness.currentStatusKind).toBe('live')
    expect(harness.handledFrames).toBe(1)
  })

  it('restarts a stream that stays frame-less after the repaint', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()

    await vi.advanceTimersByTimeAsync(5_000)

    expect(harness.streams).toHaveLength(2)
    expect(harness.streams[0].unsubscribeCount).toBe(1)
    expect(harness.currentStatusKind).toBe('retrying')
  })

  it('offers reconnect when every accepted stream stays frame-less', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()

    for (let round = 0; round < 6; round++) {
      harness.streams.at(-1)!.emitReady()
      await vi.advanceTimersByTimeAsync(20_000)
    }

    expect(harness.reconnectOffered).toBe(true)
    expect(harness.busyLog.at(-1)).toBe(false)
    expect(harness.currentError).not.toBeNull()
  })

  it('cancels first-frame recovery when the pane closes', async () => {
    const harness = createHarness()
    const close = harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()

    close()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.rpcLog).not.toContain('browser.eval')
    expect(harness.streams[0].unsubscribeCount).toBe(1)
  })

  it('publishes live only for the first frame', async () => {
    const harness = createHarness()
    await openStreamAndConfirmReady(harness)
    const statusWrites = harness.statusLog.length

    harness.streams[0].emitFrame()
    harness.streams[0].emitFrame()
    await settle()

    expect(harness.statusLog).toHaveLength(statusWrites)
    expect(harness.handledFrames).toBe(3)
  })

  it('does not revive a stopped stream from a late first frame', async () => {
    const harness = createHarness()
    harness.lifecycle.open()
    await settle()
    harness.streams[0].emitReady()
    harness.streams[0].emitTransportError('runtime_unavailable', 'socket failed')

    harness.streams[0].emitFrame()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.currentStatusKind).toBe('stopped')
    expect(harness.rpcLog).not.toContain('browser.eval')
  })
})
