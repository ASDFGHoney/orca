import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import {
  SessionNotFoundError,
  TerminalSessionExitedError,
  TerminalSessionOwnerUnverifiedError
} from './daemon-errors'

export type DaemonSessionOwnerResolution<T extends IPtyProvider> =
  | { kind: 'owner'; provider: T }
  | { kind: 'absent' }
  | { kind: 'unknown' }

type ProviderInventory<T> = { provider: T; processes: PtyProcessInfo[] | null }

type OwnerInventory<T extends IPtyProvider> = {
  candidatesBySessionId: Map<string, { provider: T; process: PtyProcessInfo }[]>
  complete: boolean
  epoch: number
}

const OWNER_RESOLUTION_TIMEOUT_MS = 2_000
const OWNER_INVENTORY_CACHE_MS = 1_000
const FAILED_PROVIDER_COOLDOWN_MS = 1_000

function assertClientConnected(signal: PtySpawnOptions['signal']): void {
  if (signal?.aborted) {
    throw new Error('client_disconnected')
  }
}

export class DaemonSessionOwnerResolver<T extends IPtyProvider> {
  private readonly providerSet: ReadonlySet<IPtyProvider>
  private inventoryInFlight: Promise<OwnerInventory<T>> | null = null
  private cachedInventory: { value: OwnerInventory<T>; expiresAt: number } | null = null
  private readonly failedProviderCooldowns = new Map<T, number>()
  private readonly routeIncarnations = new Map<string, string | undefined>()
  private epoch = 0

  constructor(
    private readonly providers: readonly T[],
    private readonly routes: Map<string, IPtyProvider>
  ) {
    this.providerSet = new Set(providers)
  }

  invalidateProvider(provider: T): void {
    this.epoch += 1
    this.inventoryInFlight = null
    this.cachedInventory = null
    this.failedProviderCooldowns.clear()
    for (const [sessionId, routed] of this.routes) {
      if (routed === provider) {
        this.routes.delete(sessionId)
        this.routeIncarnations.delete(sessionId)
      }
    }
  }

  async spawnAttachOnly(opts: PtySpawnOptions & { sessionId: string }): Promise<PtySpawnResult> {
    assertClientConnected(opts.signal)
    const route = this.routes.get(opts.sessionId)
    const routed = route && this.providerSet.has(route) ? (route as T) : undefined
    const direct = routed
    const routedIncarnation = this.routeIncarnations.get(opts.sessionId)
    const routeNeedsAuthoritativeResolution =
      direct &&
      routed &&
      opts.expectedIncarnationIsAuthoritative === true &&
      routedIncarnation !== opts.expectedIncarnationId
    if (direct && !routeNeedsAuthoritativeResolution) {
      try {
        const result = await direct.spawn(opts)
        if (
          !result.exitedBeforeSpawnReply &&
          result.id === opts.sessionId &&
          result.isReattach === true
        ) {
          this.recordRoute(result.id, direct, result.incarnationId)
        }
        return result
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) {
          throw error
        }
        if (
          this.providers.length === 1 &&
          opts.expectedIncarnationIsAuthoritative &&
          routedIncarnation === opts.expectedIncarnationId &&
          this.routes.get(opts.sessionId) === routed &&
          this.routeIncarnations.get(opts.sessionId) === routedIncarnation
        ) {
          throw new TerminalSessionExitedError(opts.sessionId)
        }
        if (routed && this.routes.get(opts.sessionId) === routed) {
          this.forgetRoute(opts.sessionId, routed)
        }
      }
    }

    assertClientConnected(opts.signal)
    const resolution = await this.resolve(
      opts.sessionId,
      opts.expectedIncarnationId,
      opts.expectedIncarnationIsAuthoritative
    )
    assertClientConnected(opts.signal)
    if (resolution.kind === 'unknown') {
      throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
    }
    if (resolution.kind === 'absent') {
      throw new TerminalSessionExitedError(opts.sessionId)
    }
    try {
      const result = await resolution.provider.spawn(opts)
      if (
        !result.exitedBeforeSpawnReply &&
        result.id === opts.sessionId &&
        result.isReattach === true
      ) {
        this.recordRoute(result.id, resolution.provider, result.incarnationId)
      }
      return result
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        if (
          opts.expectedIncarnationIsAuthoritative &&
          this.routes.get(opts.sessionId) === resolution.provider &&
          this.routeIncarnations.get(opts.sessionId) === opts.expectedIncarnationId
        ) {
          throw new TerminalSessionExitedError(opts.sessionId)
        }
        throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
      }
      throw error
    }
  }

  async probe(sessionId: string, expectedIncarnationId?: string): Promise<boolean | null> {
    const route = this.routes.get(sessionId)
    const routed = route && this.providerSet.has(route) ? (route as T) : undefined
    if (routed) {
      const routedIncarnation = this.routeIncarnations.get(sessionId)
      if (
        !routedIncarnation ||
        (expectedIncarnationId !== undefined && routedIncarnation !== expectedIncarnationId)
      ) {
        return null
      }
      const verdict = routed.probePtyLiveness
        ? await routed.probePtyLiveness(sessionId, routedIncarnation)
        : (routed.hasPty?.(sessionId) ?? null)
      if (
        this.routes.get(sessionId) !== routed ||
        this.routeIncarnations.get(sessionId) !== routedIncarnation
      ) {
        return null
      }
      return verdict
    }
    return null
  }

  async resolve(
    sessionId: string,
    expectedIncarnationId?: string,
    expectedIncarnationIsAuthoritative = false
  ): Promise<DaemonSessionOwnerResolution<T>> {
    const inventory = await this.inventory()
    if (inventory.epoch !== this.epoch) {
      return { kind: 'unknown' }
    }
    const resolution = this.resolveInventory(
      inventory,
      sessionId,
      expectedIncarnationId,
      expectedIncarnationIsAuthoritative
    )
    if (
      (!inventory.complete || resolution.kind === 'unknown') &&
      this.cachedInventory?.value !== inventory
    ) {
      this.cachedInventory = {
        value: inventory,
        expiresAt: Date.now() + OWNER_INVENTORY_CACHE_MS
      }
    }
    return resolution
  }

  async discoverRoutes(): Promise<void> {
    await this.inventory()
    this.failedProviderCooldowns.clear()
    this.cachedInventory = null
  }

  recordRoute(sessionId: string, provider: T, incarnationId?: string): void {
    this.routes.set(sessionId, provider)
    this.routeIncarnations.set(sessionId, incarnationId)
  }

  forgetRoute(sessionId: string, provider?: T): void {
    if (provider && this.routes.get(sessionId) !== provider) {
      return
    }
    this.routes.delete(sessionId)
    this.routeIncarnations.delete(sessionId)
    this.cachedInventory = null
  }

  private resolveInventory(
    inventory: OwnerInventory<T>,
    sessionId: string,
    expectedIncarnationId?: string,
    expectedIncarnationIsAuthoritative = false
  ): DaemonSessionOwnerResolution<T> {
    const candidates = inventory.candidatesBySessionId.get(sessionId) ?? []
    const providers = new Set(candidates.map(({ provider }) => provider))
    const exactProviders = new Set(
      candidates
        .filter(({ process }) => process.incarnationId === expectedIncarnationId)
        .map(({ provider }) => provider)
    )
    const exactProvider =
      expectedIncarnationId && exactProviders.size === 1
        ? exactProviders.values().next().value
        : undefined
    const soleProvider = providers.size === 1 ? providers.values().next().value : undefined
    const provider =
      exactProvider && (inventory.complete || expectedIncarnationIsAuthoritative)
        ? exactProvider
        : !expectedIncarnationIsAuthoritative && inventory.complete
          ? soleProvider
          : undefined
    if (provider) {
      const process = candidates.find((candidate) => candidate.provider === provider)?.process
      this.recordRoute(sessionId, provider, process?.incarnationId)
      return { kind: 'owner', provider }
    }
    return { kind: 'unknown' }
  }

  private inventory(): Promise<OwnerInventory<T>> {
    if (this.inventoryInFlight) {
      return this.inventoryInFlight
    }
    if (
      this.cachedInventory?.value.epoch === this.epoch &&
      this.cachedInventory.expiresAt > Date.now()
    ) {
      return Promise.resolve(this.cachedInventory.value)
    }
    this.cachedInventory = null
    const deadlineMs = Date.now() + OWNER_RESOLUTION_TIMEOUT_MS
    const epoch = this.epoch
    const inventory = Promise.all(
      this.providers.map(async (provider): Promise<ProviderInventory<T>> => {
        if ((this.failedProviderCooldowns.get(provider) ?? 0) > Date.now()) {
          return { provider, processes: null }
        }
        this.failedProviderCooldowns.delete(provider)
        try {
          return { provider, processes: await provider.listProcesses({ deadlineMs }) }
        } catch {
          if (epoch === this.epoch) {
            this.failedProviderCooldowns.set(provider, Date.now() + FAILED_PROVIDER_COOLDOWN_MS)
          }
          return { provider, processes: null }
        }
      })
    )
      .then((entries) => this.indexInventory(entries, epoch))
      .finally(() => {
        if (this.inventoryInFlight === inventory) {
          this.inventoryInFlight = null
        }
      })
    this.inventoryInFlight = inventory
    return inventory
  }

  private indexInventory(entries: ProviderInventory<T>[], epoch: number): OwnerInventory<T> {
    const candidatesBySessionId = new Map<string, { provider: T; process: PtyProcessInfo }[]>()
    let complete = true
    for (const entry of entries) {
      if (!entry.processes) {
        complete = false
        continue
      }
      for (const process of entry.processes) {
        const candidates = candidatesBySessionId.get(process.id) ?? []
        candidates.push({ provider: entry.provider, process })
        candidatesBySessionId.set(process.id, candidates)
      }
    }
    if (complete && epoch === this.epoch) {
      for (const [sessionId, candidates] of candidatesBySessionId) {
        const providers = new Set(candidates.map(({ provider }) => provider))
        if (providers.size === 1) {
          const provider = providers.values().next().value!
          const process = candidates.find((candidate) => candidate.provider === provider)?.process
          this.recordRoute(sessionId, provider, process?.incarnationId)
        } else {
          this.forgetRoute(sessionId)
        }
      }
    }
    return { candidatesBySessionId, complete, epoch }
  }
}
