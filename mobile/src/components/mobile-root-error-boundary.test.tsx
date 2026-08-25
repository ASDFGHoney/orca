import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hideSplash: vi.fn().mockResolvedValue(undefined),
  preventAutoHide: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  AlertTriangle: 'AlertTriangle',
  ArrowLeft: 'ArrowLeft',
  RefreshCw: 'RefreshCw'
}))
vi.mock('expo-router', () => {
  function Stack(): never {
    throw new Error('route render exploded')
  }
  Stack.Screen = 'StackScreen'
  return {
    Stack,
    useRouter: () => ({ back: vi.fn(), canGoBack: () => true, replace: vi.fn() })
  }
})
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('expo-splash-screen', () => ({
  hideAsync: mocks.hideSplash,
  preventAutoHideAsync: mocks.preventAutoHide
}))
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default',
  addNotificationResponseReceivedListener: () => ({ remove: vi.fn() }),
  clearLastNotificationResponse: vi.fn(),
  getLastNotificationResponse: () => null,
  setNotificationHandler: vi.fn()
}))
vi.mock('expo-linking', () => ({
  addEventListener: () => ({ remove: vi.fn() }),
  getInitialURL: vi.fn().mockResolvedValue(null)
}))
vi.mock('./OrcaLogo', () => ({ OrcaLogo: 'OrcaLogo' }))
vi.mock('../transport/client-context', () => ({
  RpcClientProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../notifications/notification-routing', () => ({
  getNotificationNavigationTarget: vi.fn()
}))
vi.mock('../notifications/use-open-notification-route', () => ({
  useOpenNotificationRoute: () => vi.fn()
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn().mockResolvedValue([]) }))
vi.mock('../transport/pairing', () => ({ extractPairingCodeFromUrl: () => null }))
vi.mock('../transport/mobile-relay-pairing-recovery', () => ({
  recoverMobileRelayPairing: vi.fn().mockResolvedValue(undefined)
}))

import RootLayout from '../../app/_layout'

describe('mobile root error boundary', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('contains a route render failure and shows recovery actions', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    act(() => {
      renderer = create(createElement(RootLayout))
    })

    const fallback = renderer.root.findByProps({ testID: 'mobile-root-error-boundary' })
    expect(
      fallback.findAllByType('Pressable').map((button) => button.props.accessibilityLabel)
    ).toEqual(['Retry', 'Go back'])
    expect(console.error).toHaveBeenCalledWith(
      '[mobile-root-error-boundary] render crash contained by boundary',
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) })
    )
  })
})
