import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const mocks = vi.hoisted(() => ({
  platformOS: 'ios',
  keyboardHeight: 0,
  keyboardState: 0,
  /** The latest useAnimatedStyle updater, so a test can re-run it the way the
   *  UI thread does — without a React render. */
  padUpdater: null as null | (() => { paddingBottom: number })
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Platform: {
    get OS() {
      return mocks.platformOS
    }
  },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: BOTTOM_INSET, left: 0, right: 0 })
}))

// Reanimated evaluates the updater and hands its result to the view as a style,
// which is what this stand-in does; the keyboard frame is the mock's to drive.
// The shared values are getters so a re-run of a captured updater sees the
// current frame, exactly as reading `.value` on the UI thread would.
vi.mock('react-native-reanimated', async () => {
  const React = await import('react')
  return {
    default: { View: 'Animated.View' },
    KeyboardState: { UNKNOWN: 0, OPENING: 1, OPEN: 2, CLOSING: 3, CLOSED: 4 },
    useAnimatedKeyboard: () => ({
      height: {
        get value() {
          return mocks.keyboardHeight
        }
      },
      state: {
        get value() {
          return mocks.keyboardState
        }
      }
    }),
    useAnimatedStyle: (updater: () => { paddingBottom: number }) => {
      mocks.padUpdater = updater
      return updater()
    },
    // Reanimated runs the reaction off the shared values it reads; after commit
    // is close enough, and keeps the state update out of the render phase.
    useAnimatedReaction: (
      prepare: () => unknown,
      react: (current: unknown, previous: unknown) => void
    ) => {
      const previous = React.useRef<unknown>(null)
      const current = prepare()
      React.useEffect(() => {
        react(current, previous.current)
        previous.current = current
      })
    },
    runOnJS: (fn: unknown) => fn,
    useSharedValue: (value: unknown) => ({ value })
  }
})

vi.mock('react-native-gesture-handler', () => {
  const chain = {
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain
  }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))

vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

// Stand-in composer: exposes the view's `handleSend` through a pressable, which is
// the only composer behaviour these banner tests exercise.
vi.mock('./MobileNativeChatComposer', async () => {
  const React = await import('react')
  return {
    MobileNativeChatComposer: (props: {
      onSend: (text: string) => Promise<boolean>
      disabled?: boolean
      placeholder?: string
    }) =>
      React.createElement('Composer', {
        ...props,
        accessibilityLabel: 'Send message',
        onPress: () => props.onSend('hi')
      })
  }
})

const KEYBOARD_HEIGHT = 336
const BOTTOM_INSET = 34
/** The route lifts by the keyboard height minus the home indicator on iOS. */
const ROUTE_INSET = KEYBOARD_HEIGHT - BOTTOM_INSET
const KEYBOARD_OPEN = 2
const KEYBOARD_CLOSING = 3
const KEYBOARD_CLOSED = 4

/** `useKeyboardFrame` binds its platform source once at module load, so the
 *  Android branch only runs in a freshly imported copy of the view. */
async function loadChatViewForPlatform(platformOS: string): Promise<typeof MobileNativeChatView> {
  mocks.platformOS = platformOS
  vi.resetModules()
  return (await import('./MobileNativeChatView')).MobileNativeChatView
}

type Overrides = {
  messages?: Parameters<typeof MobileNativeChatView>[0]['messages']
  folded?: Parameters<typeof MobileNativeChatView>[0]['folded']
  streaming?: string | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  inputLockReason?: 'disconnected' | 'waiting' | null
  onSend?: (text: string) => Promise<boolean>
  pending?: Parameters<typeof MobileNativeChatView>[0]['pending']
  keyboardInset?: number
}

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function chatViewProps(overrides: Overrides): Parameters<typeof MobileNativeChatView>[0] {
  return {
    messages: [],
    folded: [],
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    ...overrides
  }
}

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, chatViewProps(overrides))
}

describe('MobileNativeChatView', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    mocks.platformOS = 'ios'
    mocks.keyboardHeight = 0
    mocks.keyboardState = 0
    mocks.padUpdater = null
  })

  async function render(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer = create(chatViewElement(overrides))
    })
  }

  async function update(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer?.update(chatViewElement(overrides))
    })
  }

  /** Ids of the rows the list is currently rendering. */
  function listIds(): string[] {
    const list = renderer!.root.find((node) => node.type === 'FlatList')
    return (list.props.data as { id: string }[]).map((row) => row.id)
  }

  function renderedRow(id: string): ReturnType<typeof createElement> {
    const list = renderer!.root.find((node) => node.type === 'FlatList')
    const data = list.props.data as NativeChatMessage[]
    const index = data.findIndex((row) => row.id === id)
    return list.props.renderItem({ item: data[index], index })
  }

  function banners(): ReactTestInstance[] {
    return renderer!.root.findAll((node) => node.props.accessibilityRole === 'alert')
  }

  function composer(): ReactTestInstance {
    return renderer!.root.find((node) => node.type === 'Composer')
  }

  function bannerText(): string {
    const [alert, ...rest] = banners()
    expect(rest).toHaveLength(0)
    return alert
      .findAll((node) => node.type === 'Text')
      .map((node) => node.props.children)
      .join('')
  }

  async function pressSend(): Promise<void> {
    const composer = renderer!.root.find((node) => node.type === 'Composer') as {
      props: { onPress: () => Promise<boolean> }
    }
    await act(async () => {
      await composer.props.onPress()
    })
  }

  function listProps(): Record<string, unknown> {
    return renderer!.root.find((node) => node.type === 'FlatList').props
  }

  /** Bottom padding the chat root actually renders with. */
  function rootPaddingBottom(): number {
    const root = renderer!.root.find((node) => node.type === 'Animated.View')
    return Object.assign({}, ...(root.props.style as { paddingBottom?: number }[])).paddingBottom
  }

  it('lets the list drag the iOS keyboard down with the finger', async () => {
    mocks.keyboardState = KEYBOARD_OPEN
    mocks.keyboardHeight = KEYBOARD_HEIGHT

    await render({ keyboardInset: ROUTE_INSET })

    expect(listProps().keyboardDismissMode).toBe('interactive')
  })

  it('will not drag a keyboard the observer cannot report', async () => {
    // Mounting with the keyboard already up (chat<->terminal toggle) leaves
    // Reanimated's interactive-drag KVO unarmed, so an interactive drag would
    // strand the composer at full lift. Dismiss on drag until a frame lands.
    await render({ keyboardInset: ROUTE_INSET })

    expect(listProps().keyboardDismissMode).toBe('on-drag')
  })

  it('dismisses on drag where there is no interactive keyboard', async () => {
    const AndroidChatView = await loadChatViewForPlatform('android')

    await act(async () => {
      renderer = create(createElement(AndroidChatView, chatViewProps({})))
    })

    expect(listProps().keyboardDismissMode).toBe('on-drag')
  })

  it('never rides the keyboard observer on Android', async () => {
    // Reanimated's Android observer would seize the activity's window insets,
    // so that platform must stay on the route inset even mid-"drag".
    const AndroidChatView = await loadChatViewForPlatform('android')
    mocks.keyboardState = KEYBOARD_CLOSING
    mocks.keyboardHeight = 180

    await act(async () => {
      renderer = create(
        createElement(AndroidChatView, chatViewProps({ keyboardInset: ROUTE_INSET }))
      )
    })

    expect(rootPaddingBottom()).toBe(KEYBOARD_HEIGHT)
  })

  it('holds the lift when a restored keyboard reports no frame to follow', async () => {
    // iOS can restore the keyboard with no animation for the observer to ride:
    // it stays CLOSED at height 0 while the route already reports full lift.
    mocks.keyboardState = KEYBOARD_CLOSED
    mocks.keyboardHeight = 0

    await render({ keyboardInset: ROUTE_INSET })

    expect(rootPaddingBottom()).toBe(KEYBOARD_HEIGHT)
  })

  it('reads the keyboard frame inside the updater, not at render time', async () => {
    // An interactive drag produces no React render — the UI thread just re-runs
    // the updater. Anything hoisted out of it would freeze at the mount value.
    mocks.keyboardState = KEYBOARD_OPEN
    mocks.keyboardHeight = KEYBOARD_HEIGHT
    await render({ keyboardInset: ROUTE_INSET })
    expect(rootPaddingBottom()).toBe(KEYBOARD_HEIGHT)

    mocks.keyboardState = KEYBOARD_CLOSING
    mocks.keyboardHeight = 120

    expect(mocks.padUpdater?.().paddingBottom).toBe(120)
  })

  it('keeps link taps landing while the keyboard is up', async () => {
    await render({ keyboardInset: ROUTE_INSET })

    expect(listProps().keyboardShouldPersistTaps).toBe('handled')
  })

  it('rides the keyboard down mid-drag instead of stranding the composer', async () => {
    mocks.keyboardState = KEYBOARD_CLOSING
    mocks.keyboardHeight = 180

    // keyboardWillHide has not fired yet, so the route still reports full lift.
    await render({ keyboardInset: ROUTE_INSET })

    expect(rootPaddingBottom()).toBe(180)
  })

  it('sits on the keyboard while it is open', async () => {
    mocks.keyboardState = KEYBOARD_OPEN
    mocks.keyboardHeight = KEYBOARD_HEIGHT

    await render({ keyboardInset: ROUTE_INSET })

    expect(rootPaddingBottom()).toBe(KEYBOARD_HEIGHT)
  })

  it('falls back to the route lift before the keyboard observer reports', async () => {
    await render({ keyboardInset: ROUTE_INSET })

    expect(rootPaddingBottom()).toBe(KEYBOARD_HEIGHT)
  })

  it('renders the route-reported failure verbatim', async () => {
    await render({ sendErrorMessage: 'Permission reply failed' })

    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Permission reply failed')
  })

  it('does not duplicate the route banner when the composer rejects', async () => {
    const onClearSendError = vi.fn()
    await render({
      onSend: vi.fn().mockResolvedValue(false),
      inputLockReason: 'disconnected',
      sendErrorMessage: 'Stop failed',
      onClearSendError
    })
    await pressSend()

    expect(onClearSendError).not.toHaveBeenCalled()
    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Stop failed')
    expect(bannerText()).toBe('Stop failed')
  })

  it('retires the route-owned banner once a send is accepted', async () => {
    const onClearSendError = vi.fn()
    await render({ sendErrorMessage: 'Stop failed', onClearSendError })

    await pressSend()

    expect(onClearSendError).toHaveBeenCalledOnce()
  })

  // The gate that decides `streaming` lives in MobileNativeChatOverlay, which
  // outlives this view; see MobileNativeChatOverlay.test.ts.
  it('appends the gated streaming bubble after the folded transcript', async () => {
    const folded = [assistantTurn('a1', 'The tests pass.')]
    await render({ folded })
    expect(listIds()).toEqual(['a1'])

    await update({ folded, streaming: 'The tests' })

    expect(listIds()).toEqual(['a1', 'streaming'])
  })

  it('renders an accepted optimistic image send without a queued state', async () => {
    await render({
      pending: [{ id: 'pending-1', text: 'look', images: ['file:///phone-photo.jpg'] }]
    })

    expect(listIds()).toEqual(['pending-1'])
    expect(renderedRow('pending-1').props).not.toHaveProperty('queued')
  })

  it('keeps a visible lock through a subscribed-end lease blip', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => vi.advanceTimersByTime(600))
      expect(composer().props.disabled).toBe(true)

      await update({ inputLockReason: null })
      expect(composer().props.disabled).toBe(true)
      await act(async () => vi.advanceTimersByTime(300))
      await update({ inputLockReason: 'waiting' })
      await act(async () => vi.advanceTimersByTime(600))

      expect(composer().props.disabled).toBe(true)
      expect(composer().props.placeholder).toBe('Waiting for terminal…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('unlocks after the lease stays ready', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => vi.advanceTimersByTime(600))
      await update({ inputLockReason: null })
      await act(async () => vi.advanceTimersByTime(599))
      expect(composer().props.disabled).toBe(true)

      await act(async () => vi.advanceTimersByTime(1))

      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')
    } finally {
      vi.useRealTimers()
    }
  })
})
