import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests,
  type RemoteRuntimeMultiplexedTerminal
} from './remote-runtime-terminal-multiplexer'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

/**
 * Park/reveal re-subscribe contract for the paired-client multiplexer.
 *
 * Parking a mirrored remote tab closes that tab's multiplexed stream while a
 * sibling stream (another open tab) keeps the multiplexer alive, so the reveal
 * re-subscribes on a multiplexer instance that has already retired a stream.
 * This pins that the revealed stream goes live again: onSubscribed fires, the
 * initial snapshot lands, input reaches the host, and live output paints.
 *
 * NOTE: this does NOT reproduce the STA-5098 CI failure
 * (paired-remote-terminal-parked-reveal-interactivity.spec.ts, cold-parked
 * scenario: restoredBuffer=true, hostReceivedInput=false, paintedLive=false).
 * It was written to test that hypothesis and it came back green, which
 * exonerates this layer — the wedge is above the multiplexer. Keep it as a
 * guard on the contract, not as coverage for that ticket.
 */

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { message: string }) => void
  onClose?: () => void
}

/** Multi-stream stand-in for the host's terminal.multiplex handler. */
class FakeMultiplexServer {
  readonly liveStreamIds = new Set<number>()
  readonly inputByStreamId = new Map<number, string[]>()
  private readonly cursorByStreamId = new Map<number, number>()

  constructor(private readonly toClient: (bytes: Uint8Array<ArrayBufferLike>) => void) {}

  receive(bytes: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Subscribe) {
      const payload = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)
      const streamId = payload?.streamId
      if (typeof streamId !== 'number') {
        return
      }
      this.liveStreamIds.add(streamId)
      this.cursorByStreamId.set(streamId, 0)
      this.sendSnapshot(streamId)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
      this.liveStreamIds.delete(frame.streamId)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Input) {
      if (!this.liveStreamIds.has(frame.streamId)) {
        return
      }
      const received = this.inputByStreamId.get(frame.streamId) ?? []
      received.push(decodeTerminalStreamText(frame.payload))
      this.inputByStreamId.set(frame.streamId, received)
    }
  }

  private send(
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array,
    seq: number
  ): void {
    this.toClient(encodeTerminalStreamFrame({ opcode, streamId, seq, payload }))
  }

  private sendSnapshot(streamId: number): void {
    this.send(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ cols: 80, rows: 24, seq: 0 }),
      0
    )
    this.send(streamId, TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText('READY:'), 0)
    this.send(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array(), 0)
  }

  /** Live paint on an established stream. */
  output(streamId: number, text: string): void {
    const seq = (this.cursorByStreamId.get(streamId) ?? 0) + text.length
    this.cursorByStreamId.set(streamId, seq)
    this.send(streamId, TerminalStreamOpcode.Output, encodeTerminalStreamText(text), seq)
  }
}

type Viewer = {
  stream: RemoteRuntimeMultiplexedTerminal
  data: string[]
  snapshots: string[]
  subscribedCount: number
}

describe('paired reveal after a cold park re-subscribes a live stream', () => {
  const unsubscribe = vi.fn()
  let server: FakeMultiplexServer
  let subscribe: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    subscribe = vi.fn(async (_args: unknown, callbacks: SubscribeCallbacks) => {
      server = new FakeMultiplexServer((bytes) => callbacks.onBinary?.(bytes))
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return {
        unsubscribe,
        sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => server.receive(bytes)
      }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function openViewer(terminal: string): Promise<Viewer> {
    const viewer: Partial<Viewer> & Pick<Viewer, 'data' | 'snapshots' | 'subscribedCount'> = {
      data: [],
      snapshots: [],
      subscribedCount: 0
    }
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const stream = await multiplexer.subscribeTerminal({
      terminal,
      client: { id: `desktop-${terminal}`, type: 'desktop' },
      viewport: { cols: 80, rows: 24 },
      callbacks: {
        onData: (chunk) => viewer.data.push(chunk),
        onSnapshot: (chunk) => viewer.snapshots.push(chunk),
        onSubscribed: () => {
          viewer.subscribedCount += 1
        }
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    return { ...(viewer as Viewer), stream }
  }

  it('makes the revealed stream live again while a sibling tab holds the multiplexer open', async () => {
    // Sibling tab the spec keeps mounted: it is what stops closeIfIdle from
    // tearing the multiplexer down when the target parks.
    const sibling = await openViewer('terminal-decoy')
    const target = await openViewer('terminal-target')
    expect(target.subscribedCount).toBe(1)

    // Cold park unmounts the pane, which closes just this tab's stream.
    target.stream.close()
    expect(server.liveStreamIds.has(target.stream.streamId)).toBe(false)
    expect(server.liveStreamIds.has(sibling.stream.streamId)).toBe(true)

    // Reveal remounts the pane and subscribes again on the same multiplexer.
    const revealed = await openViewer('terminal-target')

    // onSubscribed is what flips the transport to attached; without it input is
    // dropped before it is sent and nothing paints.
    expect(revealed.subscribedCount).toBe(1)
    expect(revealed.snapshots.join('')).toContain('READY:')

    expect(revealed.stream.sendInput('echo sta5098\r')).toBe(true)
    expect(server.inputByStreamId.get(revealed.stream.streamId)).toEqual(['echo sta5098\r'])

    server.output(revealed.stream.streamId, 'sta5098-live')
    expect(revealed.data.join('')).toContain('sta5098-live')
  })
})
