import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View'
}))

vi.mock('./MobileNativeChatView', () => ({ MobileNativeChatView: 'ChatView' }))

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

/** One render of the route: chat visible or not, the transcript it currently
 *  holds, and the agent-status stream behind it. */
type Tick = {
  show?: boolean
  messages?: NativeChatMessage[]
  streamingText?: string
  streamLive?: boolean
  identity?: string
  /** The host's paging answer, which decides whether the oldest visible row is
   *  a window head that may have lost its image-source run. */
  hasMore?: boolean
}

function overlayElement(tick: Tick): ReturnType<typeof createElement> {
  const controller = {
    showNativeChat: tick.show ?? true,
    nativeChatSession: {
      messages: tick.messages ?? [],
      status: 'ready',
      hasMore: tick.hasMore ?? false
    },
    nativeChatAgent: 'claude',
    nativeChatAgentWorking: tick.streamLive ?? false,
    nativeChatStreamingText: tick.streamingText,
    nativeChatStreamLive: tick.streamLive ?? false,
    nativeChatStreamScopeKey: tick.identity ?? 'tab-a',
    chatPending: [],
    chatImagePreviewsByMessageId: {},
    chatComposerText: '',
    setChatComposerText: vi.fn()
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    images: {} as never,
    onMicPress: vi.fn(),
    micActive: false,
    dictationMode: 'toggle',
    onMicPressIn: vi.fn(),
    onMicPressOut: vi.fn(),
    inputLockReason: null,
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    keyboardInset: 0
  })
}

describe('MobileNativeChatOverlay streaming gate', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(tick: Tick): Promise<void> {
    await act(async () => {
      renderer = create(overlayElement(tick))
    })
  }

  async function update(tick: Tick): Promise<void> {
    await act(async () => {
      renderer?.update(overlayElement(tick))
    })
  }

  /** The bubble text handed to the chat list, or `'hidden'` when chat is off. */
  function streaming(): string | null | 'hidden' {
    const views = renderer!.root.findAll((node) => node.type === 'ChatView')
    return views.length === 0 ? 'hidden' : (views[0].props.streaming as string | null)
  }

  it('keeps streaming a reply that repeats the previous turn as a prefix', async () => {
    const prior = [assistantTurn('a1', 'The tests pass.')]
    await render({ messages: prior })
    expect(streaming()).toBeNull()

    await update({ messages: prior, streamingText: 'The tests', streamLive: true })

    expect(streaming()).toBe('The tests')
  })

  it('drops the streaming bubble once the reply lands as its own turn', async () => {
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })
    expect(streaming()).toBe('Done.')

    await update({
      messages: [...prior, assistantTurn('a2', 'Done.')],
      streamingText: 'Done.',
      streamLive: true
    })

    expect(streaming()).toBeNull()
  })

  it('keeps the bubble across a peek at the terminal view', async () => {
    // Toggling to the terminal unmounts the chat list and unsubscribes its
    // transcript. The gate lives above that boundary, so the baseline survives
    // and the repeated-prefix reply keeps streaming on the way back.
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })
    expect(streaming()).toBe('Done.')

    await update({ show: false, messages: [], streamLive: true })
    expect(streaming()).toBe('hidden')
    // Back on chat the session withholds its transcript until a fresh read
    // settles, so the throttled stream text returns a round trip ahead of it.
    await update({ messages: [], streamLive: true })
    await update({ messages: [], streamingText: 'Done.', streamLive: true })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })

    expect(streaming()).toBe('Done.')
  })

  it('keeps the bubble across a peek at the terminal taken between turns', async () => {
    // Same toggle, but taken while idle: the transcript empties before the next
    // turn starts, so the gate has to reject that empty tail as a baseline.
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })

    await update({ show: false, messages: [] })
    await update({ show: false, messages: [], streamLive: true })
    await update({ messages: [], streamLive: true })
    await update({ messages: [], streamingText: 'Done.', streamLive: true })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })

    expect(streaming()).toBe('Done.')
  })

  it('hides a repeated part whose own turn landed during a mid-turn gap', async () => {
    // Between parts the status frame carries no assistant text (a tool call), so
    // the stream goes textless while the turn is still live and the part that
    // just finished lands in the transcript. Re-anchoring on that tick would
    // adopt it as history and render it a second time.
    const prior = [assistantTurn('a1', 'Done.')]
    await render({ messages: prior })
    await update({ messages: prior, streamingText: 'Done.', streamLive: true })
    expect(streaming()).toBe('Done.')

    const landed = [...prior, assistantTurn('a2', 'Done.')]
    await update({ messages: landed, streamLive: true })
    await update({ messages: landed, streamingText: 'Done.', streamLive: true })

    expect(streaming()).toBeNull()
  })

  it("does not carry one chat's baseline into another stream identity", async () => {
    const prior = [assistantTurn('a1', 'Shared answer text')]
    await render({ messages: prior, identity: 'tab-a' })

    await update({
      messages: prior,
      streamingText: 'Shared answer',
      streamLive: true,
      identity: 'tab-b'
    })

    expect(streaming()).toBeNull()
  })
})

// STA-4363, mobile half. The window-head rule strips a head turn's `[Image #n]`
// run because the read window may have trimmed the source turns that vouch for
// it — true only while older history exists. Desktop derives the head from its
// read list, mobile from the merged list, so pin mobile's own derivation: a
// pure-function test of the fold cannot see this call site stop guarding it.
describe('MobileNativeChatOverlay window-head marker rule', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function markerTurn(id: string, text: string, timestamp: number): NativeChatMessage {
    return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
  }

  async function foldedById(hasMore: boolean): Promise<Map<string, unknown>> {
    await act(async () => {
      renderer = create(
        overlayElement({
          hasMore,
          messages: [
            markerTurn('u-head', '[Image #1] hello', 1),
            markerTurn('u-tail', '[Image #2] bye', 2)
          ]
        })
      )
    })
    const folded = renderer!.root.findAll((node) => node.type === 'ChatView')[0].props
      .folded as NativeChatMessage[]
    return new Map(folded.map((message) => [message.id, message.blocks]))
  }

  it('keeps the head turn’s literal markers when the window holds the whole conversation', async () => {
    expect((await foldedById(false)).get('u-head')).toEqual([
      { type: 'text', text: '[Image #1] hello' }
    ])
  })

  it('strips the head turn’s markers only while older history is still pageable', async () => {
    expect((await foldedById(true)).get('u-head')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('leaves a turn below the head literal even while older history exists', async () => {
    expect((await foldedById(true)).get('u-tail')).toEqual([
      { type: 'text', text: '[Image #2] bye' }
    ])
  })
})
