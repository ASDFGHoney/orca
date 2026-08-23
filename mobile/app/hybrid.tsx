import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileWebShellViewRef } from '@orca/expo-mobile-web-shell'
import * as ExpoCrypto from 'expo-crypto'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage,
  type MobileWebResumeRoute
} from '../../src/shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_PRODUCTION_GRANTS,
  MobileWebCapabilityBroker
} from '../src/mobile-web/mobile-web-capability-broker'
import { MobileWebHealthDeadline } from '../src/mobile-web/mobile-web-health-deadline'
import { useMobileWebPackageSession } from '../src/mobile-web/use-mobile-web-package-session'
import { createMobileWebNativeCapabilityAuthority } from '../src/mobile-web/mobile-web-native-capability-authority'
import { MobileWebHybridShellPresentation } from '../src/mobile-web/MobileWebHybridShellPresentation'
import { useMobileWebNavigationIntentHandoff } from '../src/mobile-web/use-mobile-web-navigation-intent-handoff'
import { useMobileWebColdResumeRoute } from '../src/mobile-web/use-mobile-web-cold-resume-route'
import { mobileWebBridgeConnectionState } from '../src/mobile-web/mobile-web-bridge-connection-state'
import { MobileWebOneShotResponseDrop } from '../src/mobile-web/mobile-web-one-shot-response-drop'
import { useMobileWebE2eHostSelection } from '../src/mobile-web/mobile-web-e2e-host-selection'
import { useMobileWebUserGestureAuthority as useGestureAuthority } from '../src/mobile-web/use-mobile-web-user-gesture-authority'
import { useMobileWebHostCatalog } from '../src/mobile-web/use-mobile-web-host-catalog'
import { mobileWebDiagnosticsStore } from '../src/mobile-web/mobile-web-diagnostics-store'
import { useMobileWebBridgeRuntimeRef } from '../src/mobile-web/use-mobile-web-bridge-runtime-ref'
import {
  completeMobileWebNativeRouteHandoffAfterResponse,
  MobileWebNativeRouteHandoff
} from '../src/mobile-web/mobile-web-native-route-handoff'
import {
  useForceReconnect,
  useForgetHostClient,
  useHostClient
} from '../src/transport/client-context'
import {
  useLastConnectedAt,
  useReconnectAttempt
} from '../src/transport/client-context-connection-metrics'
import { removeHostAndCloseClient } from '../src/transport/host-removal-lifecycle'
import { leaveHostRoute } from '../src/host-route-exit'

export default function HybridScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ hostId?: string }>()
  const viewRef = useRef<MobileWebShellViewRef>(null)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const initializedSessionRef = useRef<string | undefined>(undefined)
  const resumeRouteRef = useRef<MobileWebResumeRoute>({ kind: 'workspaceList' })
  const healthDeadlineRef = useRef(new MobileWebHealthDeadline(10_000))
  const brokerRef = useRef<MobileWebCapabilityBroker | null>(null)
  const postInitRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const nativeRouteHandoffRef = useRef(new MobileWebNativeRouteHandoff())
  const recentWebGestureAtRef = useRef<number | null>(null)
  const consumeRecentUserGesture = useGestureAuthority(recentWebGestureAtRef, brokerRef)
  const responseDropRef = useRef(
    new MobileWebOneShotResponseDrop(process.env.EXPO_PUBLIC_ORCA_E2E_MOBILE_WEB_DROP_RESPONSE_ONCE)
  )
  const { hosts, hostsLoading, hostLoadError, refreshHosts } = useMobileWebHostCatalog()
  const [selectedHostId, setSelectedHostId] = useState<string | undefined>(params.hostId)
  const [pageReadySessionId, setPageReadySessionId] = useState<string>()
  const [brokerSessionId, setBrokerSessionId] = useState<string>()
  const [hostedViewActive, setHostedViewActive] = useState(true)
  const selectHost = useCallback((hostId: string | undefined) => setSelectedHostId(hostId), [])
  const e2eHostId = useMobileWebE2eHostSelection(hosts, selectedHostId, selectHost)
  const { client, state } = useHostClient(selectedHostId)
  const closeHostClient = useForgetHostClient()
  const forceReconnectHost = useForceReconnect()
  const reconnectAttempts = useReconnectAttempt(selectedHostId)
  const lastConnectedAt = useLastConnectedAt(selectedHostId)
  const selectedHost = useMemo(
    () => hosts.find((host) => host.id === selectedHostId),
    [hosts, selectedHostId]
  )
  const {
    session,
    viewEpoch,
    packageLoading,
    packageWarning,
    markHealthy,
    handleHealthTimeout,
    handleProcessTerminated,
    retryPackage,
    recoverPrevious,
    clearCache,
    showWarning
  } = useMobileWebPackageSession({ client, host: selectedHost, state })
  const bridgeRuntimeRef = useMobileWebBridgeRuntimeRef(client, state, session?.sessionId)
  const coldResumeRoute = useMobileWebColdResumeRoute({
    hosts,
    hostsLoading,
    hostsLoadFailed: hostLoadError,
    explicitHostId: params.hostId ?? e2eHostId,
    selectedHostId,
    shellSessionId: session?.sessionId,
    selectHost
  })

  useEffect(() => {
    if (hostsLoading || selectedHost || e2eHostId) {
      return
    }
    coldResumeRoute.clearRoute()
    leaveHostRoute(router)
  }, [coldResumeRoute.clearRoute, e2eHostId, hostsLoading, router, selectedHost])

  useEffect(() => {
    activeSessionIdRef.current = session?.sessionId
  }, [session?.sessionId])

  useFocusEffect(
    useCallback(() => {
      setHostedViewActive(true)
      const sessionId = session?.sessionId
      const view = viewRef.current
      if (sessionId && view) {
        void view.activateSessionView(sessionId).catch(() => {
          if (activeSessionIdRef.current === sessionId) {
            showWarning('Hosted session could not be restored.')
          }
        })
      }
      return () => setHostedViewActive(false)
    }, [session?.sessionId, showWarning])
  )

  useEffect(() => {
    if (params.hostId) {
      setSelectedHostId(params.hostId)
    }
  }, [params.hostId])

  useEffect(() => {
    initializedSessionRef.current = undefined
    resumeRouteRef.current = { kind: 'workspaceList' }
    recentWebGestureAtRef.current = null
    nativeRouteHandoffRef.current.clear()
    setPageReadySessionId(undefined)
    healthDeadlineRef.current.clear()
    return () => healthDeadlineRef.current.clear()
  }, [session?.sessionId])

  const postToWeb = useCallback(async (message: MobileWebBridgeShellMessage) => {
    if (responseDropRef.current.shouldDrop(message)) {
      return
    }
    const view = viewRef.current
    if (!view) {
      return
    }
    await view.postMessage(JSON.stringify(message))
  }, [])

  useEffect(() => {
    brokerRef.current?.dispose()
    brokerRef.current = null
    setBrokerSessionId(undefined)
    const current = session
    if (!current || !selectedHost) {
      return
    }
    const broker = new MobileWebCapabilityBroker({
      context: { shellSessionId: current.sessionId, buildId: current.buildId },
      getClient: () =>
        bridgeRuntimeRef.current.sessionId === current.sessionId
          ? bridgeRuntimeRef.current.client
          : null,
      isConnected: () =>
        bridgeRuntimeRef.current.sessionId === current.sessionId &&
        bridgeRuntimeRef.current.state === 'connected',
      isActive: () => activeSessionIdRef.current === current.sessionId,
      postMessage: postToWeb,
      nativeAuthority: createMobileWebNativeCapabilityAuthority({
        hostIdentity: selectedHost.publicKeyB64,
        buildIdentity: current.buildId
      }),
      navigationAuthority: {
        route(destination, requestId) {
          if (destination === 'terminalSettings') {
            nativeRouteHandoffRef.current.record(requestId, destination)
            return
          }
          coldResumeRoute.clearRoute()
          if (destination === 'hostPicker') {
            leaveHostRoute(router)
          } else {
            router.push('/pair-scan')
          }
        },
        reconnect() {
          return forceReconnectHost(selectedHost.id)
        },
        removeHost() {
          return removeHostAndCloseClient(
            selectedHost.id,
            selectedHost.publicKeyB64,
            closeHostClient
          )
        },
        consumeRecentUserGesture() {
          return consumeRecentUserGesture()
        }
      },
      terminalClientId: selectedHost.deviceToken,
      onTerminalFlowMetrics: (metrics) =>
        mobileWebDiagnosticsStore.terminalFlow(selectedHost.id, metrics),
      onTerminalResync: (reason) =>
        mobileWebDiagnosticsStore.terminalResync(selectedHost.id, reason),
      rememberRoute(route) {
        resumeRouteRef.current = route
      },
      rememberHostRoute: coldResumeRoute.rememberHostRoute,
      randomBytes: ExpoCrypto.getRandomBytes
    })
    brokerRef.current = broker
    setBrokerSessionId(current.sessionId)
    void postInitRef.current().catch(() => {})
    return () => {
      broker.dispose()
      if (brokerRef.current === broker) {
        brokerRef.current = null
      }
      setBrokerSessionId((value) => (value === current.sessionId ? undefined : value))
    }
  }, [
    closeHostClient,
    consumeRecentUserGesture,
    coldResumeRoute.clearRoute,
    coldResumeRoute.rememberHostRoute,
    forceReconnectHost,
    postToWeb,
    refreshHosts,
    router,
    selectedHost?.deviceToken,
    selectedHost?.id,
    selectedHost?.publicKeyB64,
    session?.buildId,
    session?.sessionId
  ])

  useEffect(() => {
    brokerRef.current?.replaceClient(client)
  }, [client])

  const postInit = useCallback(async () => {
    const current = session
    if (!current || activeSessionIdRef.current !== current.sessionId || !brokerRef.current) {
      return
    }
    initializedSessionRef.current = current.sessionId
    healthDeadlineRef.current.arm(current.sessionId, (sessionId) => {
      if (activeSessionIdRef.current === sessionId) {
        void handleHealthTimeout(sessionId)
      }
    })
    await postToWeb({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      shellSessionId: current.sessionId,
      buildId: current.buildId,
      connection: mobileWebBridgeConnectionState(state),
      reconnectAttempts,
      lastConnectedAt,
      resumeRoute: resumeRouteRef.current,
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS]
    })
  }, [handleHealthTimeout, lastConnectedAt, postToWeb, reconnectAttempts, session, state])
  useEffect(() => {
    postInitRef.current = postInit
  }, [postInit])

  useEffect(() => {
    brokerRef.current?.updateConnectionState(mobileWebBridgeConnectionState(state))
    const current = session
    if (!current || initializedSessionRef.current !== current.sessionId) {
      return
    }
    void postToWeb({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'connection',
      shellSessionId: current.sessionId,
      buildId: current.buildId,
      state: mobileWebBridgeConnectionState(state),
      reconnectAttempts,
      lastConnectedAt
    })
  }, [lastConnectedAt, postToWeb, reconnectAttempts, session, state])

  const handleBridgeMessage = useCallback(
    async (raw: string) => {
      const current = session
      if (!current || activeSessionIdRef.current !== current.sessionId) {
        return
      }
      const parsed = parseMobileWebBridgePageMessage(raw, {
        shellSessionId: current.sessionId,
        buildId: current.buildId
      })
      if (!parsed.ok) {
        return
      }
      responseDropRef.current.recordRequest(parsed.value)
      if (parsed.value.type === 'ready') {
        // `ready` acknowledges init; echoing init here starves the health frame.
        if (activeSessionIdRef.current === current.sessionId) {
          setPageReadySessionId(current.sessionId)
        }
      } else if (parsed.value.type === 'health') {
        healthDeadlineRef.current.acknowledge(current.sessionId)
        await markHealthy(current.sessionId)
      } else if (parsed.value.type === 'routeState') {
        brokerRef.current?.rememberRoute(parsed.value.route)
      } else {
        const broker = brokerRef.current
        await broker?.handle(parsed.value)
        if (
          parsed.value.type === 'request' &&
          broker &&
          brokerRef.current === broker &&
          activeSessionIdRef.current === current.sessionId
        ) {
          completeMobileWebNativeRouteHandoffAfterResponse({
            handoff: nativeRouteHandoffRef.current,
            requestId: parsed.value.requestId,
            shouldNavigate: () =>
              brokerRef.current === broker && activeSessionIdRef.current === current.sessionId,
            deactivateSessionView: async () => {
              const view = viewRef.current
              if (!view) {
                throw new Error('mobile_web_session_view_unavailable')
              }
              await view.deactivateSessionView()
            },
            setHostedViewActive,
            navigate: () => {
              router.push('/terminal-settings')
            },
            onFailure: () => showWarning('Terminal settings could not be opened.')
          })
        }
      }
    },
    [markHealthy, postInit, router, session, showWarning]
  )

  const shellContext = useMemo(
    () => (session ? { sessionId: session.sessionId, buildId: session.buildId } : null),
    [session?.buildId, session?.sessionId]
  )
  const getBroker = useCallback(() => brokerRef.current, [])
  const rememberRoute = useCallback((route: MobileWebResumeRoute) => {
    resumeRouteRef.current = route
  }, [])
  useMobileWebNavigationIntentHandoff({
    hosts,
    hostsLoading,
    selectedHostId,
    connectionState: state,
    shellContext,
    pageReadySessionId,
    brokerSessionId,
    getBroker,
    selectHost,
    refreshHosts,
    postMessage: postToWeb,
    rememberRoute,
    onNavigationResolved: coldResumeRoute.onNavigationResolved,
    showWarning
  })

  const handleBack = useCallback(() => {
    coldResumeRoute.clearRoute()
    leaveHostRoute(router)
  }, [coldResumeRoute.clearRoute, router])

  return (
    <MobileWebHybridShellPresentation
      viewRef={viewRef}
      selectedHost={selectedHost}
      session={session}
      viewEpoch={viewEpoch}
      packageLoading={packageLoading || !selectedHost}
      packageWarning={packageWarning}
      hostedViewActive={hostedViewActive}
      onBack={handleBack}
      onShowHosts={() => {
        coldResumeRoute.clearRoute()
        leaveHostRoute(router)
      }}
      onRetryRecovery={async () => {
        if (selectedHost && state !== 'connected') {
          await forceReconnectHost(selectedHost.id)
        }
        retryPackage()
      }}
      onUsePrevious={recoverPrevious}
      onClearCache={clearCache}
      onRecoveryFailure={() =>
        showWarning('The workspace interface recovery action could not be completed.')
      }
      onTouch={() => {
        recentWebGestureAtRef.current = Date.now()
      }}
      onBridgeMessage={(message) => void handleBridgeMessage(message)}
      onPageLoaded={() => void postInit()}
      onNavigationBlocked={() => showWarning('Navigation outside Orca was blocked.')}
      onProcessTerminated={(sessionId) => {
        healthDeadlineRef.current.clear()
        void handleProcessTerminated(sessionId)
      }}
    />
  )
}
