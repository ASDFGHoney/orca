import { onTestFinished } from 'vitest'
import {
  parseMobileWebBridgePageMessage,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgeMessageContext,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'

type InitMessage = Extract<MobileWebBridgeShellMessage, { type: 'init' }>

export const MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

export function createMobileWebBridgeRoundtripFixture(options: {
  grants: InitMessage['grants']
  rpcClient?: RpcClient | null
  context?: MobileWebBridgeMessageContext
  createRequestId?: () => string
  nativeAuthority?: Partial<MobileWebNativeCapabilityAuthority>
  navigationAuthority?: MobileWebNavigationAuthority
  isActive?: () => boolean
  isConnected?: () => boolean
  terminalClientId?: string
  randomBytes?: (length: number) => Uint8Array
}) {
  const context = options.context ?? MOBILE_WEB_BRIDGE_ROUNDTRIP_CONTEXT
  const pageMessages: MobileWebBridgePageMessage[] = []
  const shellMessages: MobileWebBridgeShellMessage[] = []
  let broker: MobileWebCapabilityBroker
  const client = new MobileWebBridgeClient({
    context,
    grants: options.grants,
    createRequestId: options.createRequestId,
    postMessage(message) {
      const parsed = parseMobileWebBridgePageMessage(JSON.stringify(message), context)
      if (!parsed.ok) {
        return false
      }
      pageMessages.push(parsed.value)
      void broker.handle(parsed.value)
      return true
    }
  })
  broker = new MobileWebCapabilityBroker({
    context,
    getClient: () => options.rpcClient ?? null,
    isConnected: options.isConnected ?? (() => options.rpcClient != null),
    isActive: options.isActive ?? (() => true),
    nativeAuthority: { ...defaultNativeAuthority(), ...options.nativeAuthority },
    navigationAuthority: options.navigationAuthority,
    terminalClientId: options.terminalClientId ?? 'roundtrip-device',
    randomBytes: options.randomBytes ?? ((length) => new Uint8Array(length).fill(1)),
    postMessage(message) {
      const parsed = parseMobileWebBridgeShellMessage(JSON.stringify(message), context)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      shellMessages.push(parsed.value)
      client.receive(parsed.value)
    }
  })
  const dispose = () => {
    client.dispose()
    broker.dispose()
  }
  onTestFinished(dispose)
  return { broker, client, dispose, pageMessages, shellMessages }
}

function defaultNativeAuthority(): MobileWebNativeCapabilityAuthority {
  return {
    alert: async () => ({ kind: 'dismissed' }),
    hapticFeedback: () => {},
    clipboardAvailability: async () => ({ hasText: false, hasImage: false }),
    clipboardWrite: async () => ({ confirmation: 'in-app' }),
    openExternal: async () => {},
    terminalPreferences: async () => ({
      textScale: 1,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser'
    }),
    terminalTextScaleUpdate: async () => {}
  }
}
