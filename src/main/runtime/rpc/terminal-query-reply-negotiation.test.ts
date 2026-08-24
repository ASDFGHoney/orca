import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import {
  makeRequest,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

const QUERY_REPLY = '\x1b[0n'

describe('terminal query-reply opcode negotiation', () => {
  it.each([
    { negotiated: true, writes: 1 },
    { negotiated: false, writes: 0 }
  ])('accepts multiplex opcode 18 only when negotiated: $negotiated', async (testCase) => {
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const harness = startDesktopMultiplexSubscribe({
      sendTerminal,
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true)
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    harness.handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: 'terminal-1',
            client: { id: 'mobile-1', type: 'mobile' },
            capabilities: {
              ackOutput: 1,
              ...(testCase.negotiated ? { queryReply: 1 } : {})
            }
          })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        harness.messages.some(
          (message) =>
            JSON.parse(message).result?.type === 'subscribed' &&
            JSON.parse(message).result?.streamId === 7
        )
      ).toBe(true)
    )
    const subscribed = harness.messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed' && event.streamId === 7)
    expect(subscribed?.capabilities?.queryReply).toBe(testCase.negotiated ? 1 : undefined)

    harness.handlers.get(7)?.(queryReplyFrame(7))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(testCase.writes))

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it.each([
    { negotiated: true, writes: 1 },
    { negotiated: false, writes: 0 }
  ])('accepts direct opcode 18 only when negotiated: $negotiated', async (testCase) => {
    const registry = createSubscriptionRegistryDouble()
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true),
      sendTerminal
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'mobile-1', type: 'mobile' },
        capabilities: {
          terminalBinaryStream: 1,
          ...(testCase.negotiated ? { queryReply: 1 } : {})
        }
      }),
      (message) => messages.push(message),
      {
        connectionId: `conn-direct-query-${testCase.negotiated}`,
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
        true
      )
    )
    const subscribed = messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed')
    expect(subscribed.capabilities?.queryReply).toBe(testCase.negotiated ? 1 : undefined)

    handlers.get(subscribed.streamId)?.(queryReplyFrame(subscribed.streamId))
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(testCase.writes))

    runtime.cleanupSubscription('terminal-1:mobile-1')
    await dispatchPromise
  })
})

function queryReplyFrame(streamId: number) {
  return decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.QueryReply,
      streamId,
      seq: 2,
      payload: encodeTerminalStreamText(QUERY_REPLY)
    })
  )!
}
