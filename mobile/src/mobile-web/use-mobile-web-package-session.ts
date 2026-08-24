import { useCallback, useEffect, useRef, useState } from 'react'
import ExpoMobileWebShell, { type MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { MobileWebProcessFailureTracker } from './mobile-web-process-failure-tracker'
import { createMobileWebNativeStager } from './mobile-web-native-stager'
import {
  downloadMobileWebPackage,
  mobileWebPackageDownloadFailureCode
} from './mobile-web-package-downloader'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'
import {
  createMobileWebCachedBuildProbe,
  type MobileWebCachedBuildProbe
} from './mobile-web-cached-build-probe'
import { mobileWebPackageRefreshWarning } from './mobile-web-package-refresh-warning'
import { useMobileWebPackageCapability } from './use-mobile-web-package-capability'
import { useMobileWebPackageRecovery } from './use-mobile-web-package-recovery'

const MOBILE_WEB_PACKAGE_UPDATE_REQUIRED_WARNING =
  'Update Orca on this desktop to use its workspace interface.'

export type MobileWebPackageSession = {
  session: MobileWebShellSession | null
  viewEpoch: number
  packageLoading: boolean
  packageWarning: string | undefined
  markHealthy: (sessionId: string) => Promise<void>
  handleHealthTimeout: (sessionId: string) => Promise<void>
  handleProcessTerminated: (sessionId: string) => Promise<void>
  retryPackage: () => void
  recoverPrevious: () => Promise<void>
  clearCache: () => Promise<void>
  showWarning: (warning: string) => void
}

export function useMobileWebPackageSession({
  client,
  host,
  state
}: {
  client: RpcClient | null
  host: HostProfile | undefined
  state: ConnectionState
}): MobileWebPackageSession {
  const hostEpochRef = useRef(0)
  const activeHostIdRef = useRef<string | null>(null)
  const ownedSessionRef = useRef<MobileWebShellSession | null>(null)
  const cachedBuildProbeRef = useRef<MobileWebCachedBuildProbe | null>(null)
  const refreshingHostEpochRef = useRef<number | null>(null)
  const processFailuresRef = useRef(new MobileWebProcessFailureTracker())
  const rejectedBuildIdsRef = useRef(new Set<string>())
  const [session, setSession] = useState<MobileWebShellSession | null>(null)
  const [viewEpoch, setViewEpoch] = useState(0)
  const [packageLoading, setPackageLoading] = useState(false)
  const [packageWarning, setPackageWarning] = useState<string>()
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const packageCapability = useMobileWebPackageCapability({
    client,
    hostId: host?.id,
    state
  })
  const packageAccessAllowed =
    packageCapability === 'offline' ||
    packageCapability === 'supported' ||
    (packageCapability === 'pending' && ownedSessionRef.current !== null)

  const publishSession = useCallback(
    async (
      next: MobileWebShellSession,
      hostEpoch: number,
      hostId: string,
      source: 'verified-cache' | 'desktop-refresh',
      activationStartedAt: number
    ): Promise<boolean> => {
      if (hostEpochRef.current !== hostEpoch) {
        await ExpoMobileWebShell.closeSession(next.sessionId).catch(() => {})
        return false
      }
      const previous = ownedSessionRef.current
      ownedSessionRef.current = next
      setSession(next)
      setViewEpoch(0)
      setPackageLoading(false)
      mobileWebDiagnosticsStore.sessionReady(
        hostId,
        next.buildId,
        source,
        Date.now() - activationStartedAt
      )
      if (previous && previous.sessionId !== next.sessionId) {
        await ExpoMobileWebShell.closeSession(previous.sessionId).catch(() => {})
      }
      return true
    },
    []
  )

  useEffect(() => {
    const hostEpoch = hostEpochRef.current + 1
    hostEpochRef.current = hostEpoch
    cachedBuildProbeRef.current?.resolve(null)
    const cachedBuildProbe = createMobileWebCachedBuildProbe(hostEpoch)
    cachedBuildProbeRef.current = cachedBuildProbe
    activeHostIdRef.current = host?.id ?? null
    refreshingHostEpochRef.current = null
    processFailuresRef.current.reset()
    rejectedBuildIdsRef.current.clear()
    const previous = ownedSessionRef.current
    ownedSessionRef.current = null
    setSession(null)
    setViewEpoch(0)
    setPackageWarning(undefined)
    setPackageLoading(Boolean(host))
    if (previous) {
      void ExpoMobileWebShell.closeSession(previous.sessionId).catch(() => {})
    }
    if (!host) {
      cachedBuildProbe.resolve(null)
      return
    }
    mobileWebDiagnosticsStore.begin(host.id)
    if (!packageAccessAllowed) {
      cachedBuildProbe.resolve(null)
      return
    }
    let disposed = false
    const cacheActivationStartedAt = Date.now()
    void ExpoMobileWebShell.openSession(host.publicKeyB64, null, MOBILE_WEB_BRIDGE_PROTOCOL_VERSION)
      .then(async (cached) => {
        const published = await (!disposed && !ownedSessionRef.current
          ? publishSession(cached, hostEpoch, host.id, 'verified-cache', cacheActivationStartedAt)
          : ExpoMobileWebShell.closeSession(cached.sessionId)
              .catch(() => {})
              .then(() => false))
        cachedBuildProbe.resolve(published ? cached.buildId : null)
      })
      .catch(() => {
        cachedBuildProbe.resolve(null)
        if (!disposed && hostEpochRef.current === hostEpoch && !ownedSessionRef.current) {
          mobileWebDiagnosticsStore.warning(host.id, 'cache_open_failed')
          if (refreshingHostEpochRef.current !== hostEpoch) {
            setPackageLoading(false)
            setPackageWarning(
              (current) =>
                current ?? 'Connect to this desktop once to cache its verified workspace UI.'
            )
          }
        }
      })
    return () => {
      disposed = true
      cachedBuildProbe.resolve(null)
      if (hostEpochRef.current !== hostEpoch) {
        return
      }
      hostEpochRef.current += 1
      activeHostIdRef.current = null
      const closing = ownedSessionRef.current
      ownedSessionRef.current = null
      if (closing) {
        void ExpoMobileWebShell.closeSession(closing.sessionId).catch(() => {})
      }
    }
  }, [host?.id, host?.publicKeyB64, packageAccessAllowed, publishSession])

  useEffect(() => {
    if (!host || packageAccessAllowed) {
      return
    }
    setPackageLoading(packageCapability === 'pending')
    if (packageCapability === 'update-required') {
      mobileWebDiagnosticsStore.warning(host.id, 'host_update_required')
      setPackageWarning(MOBILE_WEB_PACKAGE_UPDATE_REQUIRED_WARNING)
    }
  }, [host?.id, packageAccessAllowed, packageCapability])

  useEffect(() => {
    if (!host || !client || state !== 'connected' || packageCapability !== 'supported') {
      return
    }
    const hostEpoch = hostEpochRef.current
    const cachedBuildProbe = cachedBuildProbeRef.current
    const controller = new AbortController()
    refreshingHostEpochRef.current = hostEpoch
    setPackageLoading(true)
    setPackageWarning(undefined)
    void (async () => {
      const refreshStartedAt = Date.now()
      try {
        const downloaded = await downloadMobileWebPackage(
          (method, params) => client.sendRequest(method, params),
          createMobileWebNativeStager(host.publicKeyB64),
          {
            shellBridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
            signal: controller.signal,
            reuseVerifiedBuild: async (buildId) => {
              const verifiedBuildId =
                cachedBuildProbe?.hostEpoch === hostEpoch ? await cachedBuildProbe.promise : null
              return (
                !controller.signal.aborted &&
                hostEpochRef.current === hostEpoch &&
                verifiedBuildId === buildId &&
                ownedSessionRef.current?.buildId === buildId
              )
            }
          }
        )
        if (controller.signal.aborted || hostEpochRef.current !== hostEpoch) {
          return
        }
        if (downloaded.reusedVerifiedBuild) {
          mobileWebDiagnosticsStore.refreshSucceeded(host.id, Date.now() - refreshStartedAt)
          setPackageLoading(false)
          setPackageWarning(undefined)
          return
        }
        if (ownedSessionRef.current?.buildId === downloaded.commit.buildId) {
          mobileWebDiagnosticsStore.refreshSucceeded(host.id, Date.now() - refreshStartedAt)
          setPackageLoading(false)
          setPackageWarning(undefined)
          return
        }
        if (rejectedBuildIdsRef.current.has(downloaded.commit.buildId)) {
          mobileWebDiagnosticsStore.warning(host.id, 'rejected_build')
          setPackageLoading(false)
          setPackageWarning(
            'Using the previous verified interface until the desktop build changes.'
          )
          return
        }
        const activationStartedAt = Date.now()
        const next = await ExpoMobileWebShell.openSession(
          host.publicKeyB64,
          downloaded.commit.buildId,
          MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
        )
        if (
          await publishSession(next, hostEpoch, host.id, 'desktop-refresh', activationStartedAt)
        ) {
          mobileWebDiagnosticsStore.refreshSucceeded(host.id, Date.now() - refreshStartedAt)
          setPackageWarning(undefined)
        }
      } catch (error) {
        if (!controller.signal.aborted && hostEpochRef.current === hostEpoch) {
          const failureCode = mobileWebPackageDownloadFailureCode(error)
          mobileWebDiagnosticsStore.warning(host.id, failureCode)
          console.warn('[mobile-web] package refresh failed', {
            code: failureCode
          })
          setPackageLoading(false)
          setPackageWarning(
            mobileWebPackageRefreshWarning(failureCode, Boolean(ownedSessionRef.current))
          )
        }
      }
    })().finally(() => {
      if (refreshingHostEpochRef.current === hostEpoch) {
        refreshingHostEpochRef.current = null
      }
    })
    return () => {
      controller.abort()
      if (refreshingHostEpochRef.current === hostEpoch) {
        refreshingHostEpochRef.current = null
      }
    }
  }, [client, host?.id, host?.publicKeyB64, packageCapability, publishSession, refreshEpoch, state])

  const {
    markHealthy,
    handleHealthTimeout,
    handleProcessTerminated,
    retryPackage,
    recoverPrevious,
    clearCache
  } = useMobileWebPackageRecovery({
    host,
    hostEpochRef,
    activeHostIdRef,
    ownedSessionRef,
    processFailuresRef,
    rejectedBuildIdsRef,
    setSession,
    setViewEpoch,
    setPackageLoading,
    setPackageWarning,
    setRefreshEpoch
  })

  return {
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
    showWarning: setPackageWarning
  }
}
