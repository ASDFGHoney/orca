import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import WebSocketClient, { WebSocketServer, type RawData, type WebSocket as NodeWebSocket } from 'ws'
import type { PairingOffer } from '../../shared/pairing'
import { parsePairingCode } from '../../shared/pairing'
import {
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { decrypt, encrypt } from '../../shared/e2ee-crypto'
import {
  openRemoteRuntimeWebSocket,
  type RemoteRuntimeWebSocket
} from '../../shared/remote-runtime-request-websocket'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { OrcaRuntimeService } from './orca-runtime'
import { deriveRelayHostId } from './relay/relay-http-client'
import { SimulatedMobileE2EEV2Peer } from './relay/simulated-mobile-e2ee-v2-peer'
import { CloudRelayTransport } from './rpc/relay-transport'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const REQUEST_TIMEOUT_MS = 5_000
const TEST_TIMEOUT_MS = 15_000

type RpcReply = {
  id: string
  ok: boolean
  result?: unknown
  error?: { message?: string }
}

type PendingReply = {
  resolve: (reply: RpcReply) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type StructuredMobileConnection = {
  request: (method: string, params: unknown) => Promise<RpcReply>
  close: () => void
}

function openStructuredMobileConnection(pairing: PairingOffer): Promise<{
  request: StructuredMobileConnection['request']
  close: StructuredMobileConnection['close']
}> {
  return new Promise((resolve, reject) => {
    const pending = new Map<string, PendingReply>()
    let requestOrdinal = 0
    let socket: RemoteRuntimeWebSocket | null = null
    let ready = false
    const opened = openRemoteRuntimeWebSocket(pairing, {
      onClose: () => {
        if (!ready) {
          reject(new Error('mobile transport closed before authentication'))
        }
      },
      onError: (_ws, error) => {
        if (!ready) {
          reject(error)
        }
      },
      onTextFrame: (_ws, frame) => {
        if (!socket) {
          return
        }
        if (!ready) {
          try {
            const plaintext = decrypt(frame, socket.sharedKey)
            if (plaintext) {
              const message = JSON.parse(plaintext) as { type?: string }
              if (message.type === 'e2ee_authenticated') {
                ready = true
                resolve({
                  request: (method, params) => {
                    const id = `mobile-request-${++requestOrdinal}`
                    return new Promise<RpcReply>((resolveReply, rejectReply) => {
                      const timeout = setTimeout(() => {
                        pending.delete(id)
                        rejectReply(new Error(`Timed out waiting for ${method}`))
                      }, REQUEST_TIMEOUT_MS)
                      pending.set(id, { resolve: resolveReply, reject: rejectReply, timeout })
                      socket?.ws.send(
                        encrypt(
                          JSON.stringify({
                            id,
                            deviceToken: pairing.deviceToken,
                            method,
                            params
                          }),
                          socket.sharedKey
                        )
                      )
                    })
                  },
                  close: () => socket?.ws.close()
                })
              }
              return
            }
            const message = JSON.parse(frame) as { type?: string }
            if (message.type === 'e2ee_ready') {
              socket.ws.send(
                encrypt(
                  JSON.stringify({
                    type: 'e2ee_auth',
                    deviceToken: pairing.deviceToken,
                    clientCapabilities: [
                      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
                      STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY
                    ]
                  }),
                  socket.sharedKey
                )
              )
            }
          } catch (error) {
            reject(error)
          }
          return
        }
        const plaintext = decrypt(frame, socket.sharedKey)
        if (!plaintext) {
          return
        }
        const reply = JSON.parse(plaintext) as RpcReply
        const waiter = pending.get(reply.id)
        if (!waiter) {
          return
        }
        pending.delete(reply.id)
        clearTimeout(waiter.timeout)
        waiter.resolve(reply)
      }
    })
    if (!opened.ok) {
      reject(opened.error)
      return
    }
    socket = opened.socket
  })
}

function forward(socket: NodeWebSocket, raw: RawData, isBinary: boolean): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(raw, { binary: isBinary })
  }
}

function waitForOpen(socket: WebSocketClient): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function nextText(socket: WebSocketClient): Promise<string> {
  return new Promise((resolve) => socket.once('message', (raw) => resolve(raw.toString())))
}

async function openStructuredRelayConnection(
  server: OrcaRuntimeRpcServer,
  pairing: PairingOffer
): Promise<StructuredMobileConnection & { stop: () => Promise<void> }> {
  const relay = new WebSocketServer({ port: 0, perMessageDeflate: false })
  await new Promise<void>((resolve) => relay.once('listening', resolve))
  const address = relay.address()
  const keys = server.getE2EEKeypair()
  const wiring = server.getMobileSocketWiring()
  if (!address || typeof address === 'string' || !keys || !wiring || !pairing.pairedDeviceId) {
    throw new Error('relay test setup unavailable')
  }
  const relayHostId = deriveRelayHostId(keys.publicKey)
  let hostSocket: NodeWebSocket | null = null
  let phoneSocket: NodeWebSocket | null = null
  let phoneAuthorized = false
  const maybeSplice = (): void => {
    if (!hostSocket || !phoneSocket || !phoneAuthorized) {
      return
    }
    const host = hostSocket
    const phone = phoneSocket
    host.on('message', (raw, isBinary) => forward(phone, raw, isBinary))
    phone.on('message', (raw, isBinary) => forward(host, raw, isBinary))
    phone.once('close', () => host.close())
    phone.send(JSON.stringify({ type: 'relay-hello', ok: true, credentialKind: 'invite' }))
  }
  relay.on('connection', (socket, request) => {
    if (request.url === '/v1/host/data/mobile-lifetime') {
      socket.once('message', () => {
        hostSocket = socket
        maybeSplice()
      })
      return
    }
    socket.once('message', () => {
      phoneSocket = socket
      phoneAuthorized = true
      maybeSplice()
    })
  })
  const transport = new CloudRelayTransport({
    cellUrl: `http://127.0.0.1:${address.port}`,
    relayHostId,
    generation: 1
  })
  const detach = wiring.attachTransport(transport, (socket) => transport.metadataFor(socket))
  await transport.start()
  await transport.openConnection({
    connId: 'mobile-lifetime',
    connTicket: 'A'.repeat(43),
    kind: 'invite',
    relayDeviceId: pairing.pairedDeviceId,
    attachDeadlineMs: REQUEST_TIMEOUT_MS
  })

  const phone = new WebSocketClient(`ws://127.0.0.1:${address.port}/v1/connect/${relayHostId}`, {
    perMessageDeflate: false
  })
  await waitForOpen(phone)
  const relayHello = nextText(phone)
  phone.send(
    JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: 'B'.repeat(43) })
  )
  await relayHello

  const peer = new SimulatedMobileE2EEV2Peer(nacl.box.keyPair(), keys.publicKey, relayHostId)
  const pending = new Map<string, PendingReply>()
  let requestOrdinal = 0
  const connection = await new Promise<StructuredMobileConnection>((resolve, reject) => {
    let state: 'awaiting-ready' | 'awaiting-authenticated' | 'ready' = 'awaiting-ready'
    phone.on('message', (raw, isBinary) => {
      if (state === 'awaiting-ready') {
        if (isBinary || !peer.acceptReady(JSON.parse(raw.toString()))) {
          reject(new Error('relay E2EE ready rejected'))
          return
        }
        state = 'awaiting-authenticated'
        phone.send(
          peer.sealText(
            JSON.stringify({
              type: 'e2ee_auth',
              v: 2,
              transcriptHashB64: peer.transcriptHashB64,
              deviceToken: pairing.deviceToken
            })
          )
        )
        return
      }
      const plaintext = isBinary ? null : peer.openText(raw.toString())
      if (!plaintext) {
        return
      }
      if (state === 'awaiting-authenticated') {
        state = 'ready'
        phone.send(
          peer.sealText(
            JSON.stringify({
              type: 'e2ee_client_capabilities',
              v: 1,
              clientCapabilities: [
                STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
                STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY
              ]
            })
          )
        )
        resolve({
          request: (method, params) => {
            const id = `relay-mobile-request-${++requestOrdinal}`
            return new Promise<RpcReply>((resolveReply, rejectReply) => {
              const timeout = setTimeout(() => {
                pending.delete(id)
                rejectReply(new Error(`Timed out waiting for ${method}`))
              }, REQUEST_TIMEOUT_MS)
              pending.set(id, { resolve: resolveReply, reject: rejectReply, timeout })
              phone.send(peer.sealText(JSON.stringify({ id, method, params })))
            })
          },
          close: () => phone.terminate()
        })
        return
      }
      const reply = JSON.parse(plaintext) as RpcReply
      const waiter = pending.get(reply.id)
      if (waiter) {
        pending.delete(reply.id)
        clearTimeout(waiter.timeout)
        waiter.resolve(reply)
      }
    })
    phone.send(JSON.stringify(peer.hello))
  })
  return {
    ...connection,
    stop: async () => {
      phone.terminate()
      await transport.stop()
      detach()
      await new Promise<void>((resolve) => relay.close(() => resolve()))
    }
  }
}

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

describe('structured mobile transport lifetime', () => {
  it.each(['direct', 'relay'] as const)(
    'releases the real stream and surface holds when the paired %s socket disappears',
    { timeout: TEST_TIMEOUT_MS },
    async (transportKind) => {
      const root = await mkdtemp(join(tmpdir(), 'or-mob-'))
      const store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      const closeSession = vi.fn(async () => true)
      const adapter: StructuredAgentSessionAdapter = {
        acquire: async ({ fence, spawnToken }) => ({
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: HOST_TEST_NOW,
            spawnToken
          },
          link: {
            linkId: `link-${fence}`,
            handle: { provider: 'codex', threadId: HOST_TEST_THREAD },
            origin: 'created',
            mintedAtFence: fence,
            observedAt: HOST_TEST_NOW
          }
        }),
        closeSession,
        dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
        cancelTurn: async () => ({ cancelled: false }),
        answerPrompt: async () => undefined,
        setOption: async () => undefined
      }
      const host = new StructuredAgentSessionHost({
        store,
        adapter,
        journalRoot: root,
        claimKeyId: 'key-1',
        mintSpawnToken: () => 'spawn-mobile-transport',
        releaseGraceMs: 5,
        now: () => HOST_TEST_NOW
      })
      setStructuredAgentSessionHost(host)
      resetHostTestOperationIds()
      expect(await host.attach({ callerKey: 'setup' }, hostTestAttachParams(null))).toMatchObject({
        ok: true
      })

      const runtime = new OrcaRuntimeService()
      runtime.ensureStructuredAgentSessionHost = async () => undefined
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath: root,
        enableWebSocket: true,
        wsPort: 0
      })
      await server.start()
      let mobile: Awaited<ReturnType<typeof openStructuredMobileConnection>> | null = null
      let stopRelay = async (): Promise<void> => {}
      try {
        const offer = server.createPairingOffer({ name: 'mobile-lifetime', scope: 'mobile' })
        if (!offer.available) {
          throw new Error('pairing unavailable')
        }
        const pairing = parsePairingCode(offer.pairingUrl)
        if (!pairing) {
          throw new Error('invalid pairing')
        }
        if (transportKind === 'relay') {
          const relay = await openStructuredRelayConnection(server, pairing)
          mobile = relay
          stopRelay = relay.stop
        } else {
          mobile = await openStructuredMobileConnection(pairing)
        }
        const subscribed = await mobile.request('agentSession.subscribe', {
          sessionId: HOST_TEST_SESSION
        })
        expect(subscribed).toMatchObject({
          ok: true,
          result: { type: 'snapshot', sessionId: HOST_TEST_SESSION }
        })
        await expect(
          mobile.request('agentSession.hold', {
            sessionId: HOST_TEST_SESSION,
            holderId: 'mobile-session:1'
          })
        ).resolves.toMatchObject({ ok: true, result: { held: true } })
        expect(host.hasSession(HOST_TEST_SESSION)).toBe(true)
        expect(closeSession).not.toHaveBeenCalled()

        mobile.close()
        mobile = null

        await vi.waitFor(
          () => {
            expect(closeSession).toHaveBeenCalledWith(HOST_TEST_SESSION)
            expect(host.hasSession(HOST_TEST_SESSION)).toBe(false)
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      } finally {
        mobile?.close()
        await stopRelay()
        await server.stop()
        await host.flushAllStreamedEvents()
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
