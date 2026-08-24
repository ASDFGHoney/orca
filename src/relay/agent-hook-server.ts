import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { ORCA_HOOK_PROTOCOL_VERSION } from '../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  getEndpointFileName,
  HOOK_REQUEST_SLOWLORIS_MS,
  normalizeHookPayload,
  readRequestBody,
  resolveHookSource,
  writeEndpointFile,
  type AgentHookEventPayload,
  type HookListenerState
} from '../shared/agent-hook-listener'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference,
  isHookRequestTruncatedError
} from '../shared/agent-hook-transport-interference'
import {
  REMOTE_AGENT_HOOK_ENV,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { buildRelayHookEnvelope, hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { listenRelayHttpServer } from './relay-http-listener'
import {
  hydrateRelayHookStatusCache,
  applyRelayHookEvent,
  persistRelayHookStatusCache,
  createRelayCodexReconciler,
  reconcileRelayCodexEvent
} from './agent-hook-status-cache'
export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

const HOOK_STATUS_CACHE_FILE = 'hook-status-cache.json'
export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.orca-relay/agent-hooks`. */
  endpointDir?: string
  /** Env tag forwarded into hook payloads. Defaults to "remote", which main excludes from dev-vs-prod mismatch warnings. */
  env?: string
  /** Fixed auth token. WSL relay passes the host-issued token (already in guest env via WSLENV) so unmodified hook clients authenticate. Defaults to a fresh UUID. */
  token?: string
  /** Preferred bind port. WSL relay passes the Windows listener's port so env-sourced client coords stay truthful; falls back to :0 if occupied. Defaults to :0. */
  preferredPort?: number
  /** Called once per parsed payload; the relay wires this to `dispatcher.notify('agent.hook', envelope)`. */
  forward: RelayHookForward
}

export type RelayHookServerStartOptions = {
  publishEndpoint?: boolean
}
export class RelayAgentHookServer {
  private server: Server | null = null
  private port = 0
  private token = ''
  private env: string
  private endpointDir: string
  private endpointFilePath: string
  private endpointFileWritten = false
  private cacheFilePath: string
  private state: HookListenerState = createHookListenerState()
  private transportInterference = createHookTransportInterferenceTracker((report) => {
    process.stderr.write(`${describeHookTransportInterference(report)}\n`)
  })
  private lastEnvelopeMetaByPaneKey = new Map<
    string,
    { source: AgentHookSource; env?: string; version?: string }
  >()
  private forward: RelayHookForward
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private retryScheduler: AgentHookResultRetryScheduler
  private codexRestartReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private scheduleCodexRestartReconciliation: (paneKey: string) => void
  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.cacheFilePath = join(this.endpointDir, HOOK_STATUS_CACHE_FILE)
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
    this.retryScheduler = new AgentHookResultRetryScheduler({
      state: this.state,
      env: this.env,
      isListening: () => this.server !== null,
      applyEvent: (event, source, env, version) => {
        this.applyEvent(event, source, env, version)
      }
    })
    this.scheduleCodexRestartReconciliation = createRelayCodexReconciler({
      state: this.state,
      isListening: () => this.server !== null,
      timers: this.codexRestartReconcileTimers,
      reconcile: (event) => reconcileRelayCodexEvent(this.state, event),
      metadata: this.lastEnvelopeMetaByPaneKey,
      forward: this.forward,
      persist: () => this.persistStatusCache()
    })
  }
  async start(options: RelayHookServerStartOptions = {}): Promise<void> {
    if (this.server) {
      return
    }
    this.token = this.fixedToken ?? randomUUID()
    this.endpointFileWritten = false
    this.portFallbackApplied = false
    try {
      await this.listenOn(this.preferredPort)
    } catch (err) {
      if (this.preferredPort > 0 && (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
        this.portFallbackApplied = true
        await this.listenOn(0)
      } else {
        throw err
      }
    }
    const hydratedMetadata = hydrateRelayHookStatusCache(
      this.cacheFilePath,
      this.state,
      (paneKey) => this.scheduleCodexRestartReconciliation(paneKey)
    )
    this.lastEnvelopeMetaByPaneKey.clear()
    for (const [paneKey, metadata] of hydratedMetadata) {
      this.lastEnvelopeMetaByPaneKey.set(paneKey, metadata)
    }
    this.persistStatusCache()
    if (options.publishEndpoint !== false) {
      this.publishEndpointFile()
    }
  }
  get usedPortFallback(): boolean {
    return this.portFallbackApplied
  }
  private listenOn(port: number): Promise<void> {
    return listenRelayHttpServer(port, (req, res) => this.handleRequest(req, res)).then(
      (result) => {
        this.server = result.server
        this.port = result.port
      }
    )
  }
  publishEndpointFile(): boolean {
    if (this.port <= 0 || !this.token) {
      this.endpointFileWritten = false
      return false
    }
    this.endpointFileWritten = writeEndpointFile(this.endpointDir, this.endpointFilePath, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION
    })
    return this.endpointFileWritten
  }
  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    this.retryScheduler.clearAll()
    for (const timer of this.codexRestartReconcileTimers.values()) {
      clearTimeout(timer)
    }
    this.codexRestartReconcileTimers.clear()
    clearAllListenerCaches(this.state)
    this.lastEnvelopeMetaByPaneKey.clear()
  }
  private persistStatusCache(): void {
    persistRelayHookStatusCache(
      this.endpointDir,
      this.cacheFilePath,
      this.state,
      this.lastEnvelopeMetaByPaneKey
    )
  }
  replayCachedPayloadsForPanes(): number {
    let count = 0
    for (const [paneKey, event] of this.state.lastStatusByPaneKey.entries()) {
      const meta = this.lastEnvelopeMetaByPaneKey.get(paneKey)
      if (!meta) {
        continue
      }
      this.forward(
        buildRelayHookEnvelope(event, meta.source, meta.env, meta.version, { isReplay: true })
      )
      count++
    }
    return count
  }
  clearPaneState(paneKey: string): void {
    this.retryScheduler.clearAssistantMessageRetry(paneKey)
    this.retryScheduler.clearCodexSubagentPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
    const timer = this.codexRestartReconcileTimers.get(paneKey)
    if (timer) {
      clearTimeout(timer)
      this.codexRestartReconcileTimers.delete(paneKey)
    }
    this.persistStatusCache()
  }
  buildPtyEnv(): Record<string, string> {
    return buildRelayHookPtyEnv({
      port: this.port,
      token: this.token,
      env: this.env,
      endpointFilePath: this.endpointFilePath,
      endpointFileWritten: this.endpointFileWritten
    })
  }
  getCoordinates(): { port: number; token: string; endpointFilePath: string } {
    return { port: this.port, token: this.token, endpointFilePath: this.endpointFilePath }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.headers['x-orca-agent-hook-token'] !== this.token) {
      res.writeHead(403)
      res.end()
      return
    }
    let destroyedBySlowlorisCap = false
    req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
      destroyedBySlowlorisCap = true
      req.destroy()
    })
    try {
      const body = await readRequestBody(req)
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const source = resolveHookSource(pathname)
      if (!source) {
        res.writeHead(404)
        res.end()
        return
      }
      const event = normalizeHookPayload(this.state, source, body, this.env, {
        allowUnanchoredPreCompact: true,
        allowUnanchoredPostCompact: true
      })
      if (event) {
        const env = hookBodyEnv(body)
        const version = hookBodyVersion(body)
        this.applyEvent(event, source, env, version)
        this.retryScheduler.scheduleAssistantMessageRetry(source, body, event, env, version)
        this.retryScheduler.scheduleCodexSubagentPoll(source, body, event, env, version)
      }
      res.writeHead(204)
      res.end()
    } catch (err) {
      if (isHookRequestTruncatedError(err) && !destroyedBySlowlorisCap) {
        this.transportInterference.record({ source: null, error: err })
      }
      process.stderr.write(
        `[relay-hook-server] hook request failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
      res.writeHead(204)
      res.end()
    }
  }

  private applyEvent(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string
  ): void {
    if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
      this.retryScheduler.clearAssistantMessageRetry(event.paneKey)
    }
    const previous = this.state.lastStatusByPaneKey.get(event.paneKey)
    const diagnosticAware =
      event.reconcileDiagnostic === undefined && previous?.reconcileDiagnostic !== undefined
        ? { ...event, reconcileDiagnostic: previous.reconcileDiagnostic }
        : event
    const reconciled =
      diagnosticAware.payload.agentType === 'codex'
        ? reconcileRelayCodexEvent(this.state, diagnosticAware)
        : diagnosticAware
    applyRelayHookEvent({
      state: this.state,
      event: reconciled,
      previous,
      source,
      env,
      version,
      metadata: this.lastEnvelopeMetaByPaneKey,
      persist: () => this.persistStatusCache(),
      clearPaneState: (paneKey) => this.clearPaneState(paneKey),
      forward: this.forward
    })
    if (reconciled.payload.agentType === 'codex') {
      this.scheduleCodexRestartReconciliation(reconciled.paneKey)
    }
  }
}
