import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { BackHandler, Platform } from 'react-native'
import type {
  MobileWebBridgeMessageContext,
  MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebHardwareBackHandoff } from './mobile-web-hardware-back-handoff'

type HardwareBackHandoffOptions = {
  shellSessionId: string | undefined
  buildId: string | undefined
  forwardingEnabled: boolean
  postMessage: (message: MobileWebBridgeShellMessage) => Promise<void>
  onUnhandled: () => void
}

export function useMobileWebHardwareBackHandoff({
  shellSessionId,
  buildId,
  forwardingEnabled,
  postMessage,
  onUnhandled
}: HardwareBackHandoffOptions): MobileWebHardwareBackHandoff {
  const [handoff] = useState(() => new MobileWebHardwareBackHandoff())
  const forwardingEnabledRef = useRef(forwardingEnabled)
  const postMessageRef = useRef(postMessage)
  const onUnhandledRef = useRef(onUnhandled)
  forwardingEnabledRef.current = forwardingEnabled
  postMessageRef.current = postMessage
  onUnhandledRef.current = onUnhandled

  useEffect(() => {
    const context: MobileWebBridgeMessageContext | null =
      shellSessionId && buildId ? { shellSessionId, buildId } : null
    handoff.setContext(context)
    return () => handoff.clear()
  }, [buildId, handoff, shellSessionId])

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') {
        return
      }
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        const forwarded =
          forwardingEnabledRef.current &&
          handoff.request(
            (message) => postMessageRef.current(message),
            () => onUnhandledRef.current()
          )
        if (!forwarded) {
          onUnhandledRef.current()
        }
        return true
      })
      return () => {
        subscription.remove()
        handoff.cancelPending()
      }
    }, [handoff])
  )

  return handoff
}
