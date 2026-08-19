import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketTransport } from './rpc/ws-transport'
import { readWsFallbackPort } from './rpc/ws-fallback-port-store'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const FALLBACK_PORT_FILE = 'mobile-ws-fallback-port.json'

const heldSockets: Server[] = []
let restoreListen: (() => void) | null = null

afterEach(async () => {
  restoreListen?.()
  restoreListen = null
  await Promise.all(
    heldSockets
      .splice(0)
      .map((socket) => new Promise<void>((resolve) => socket.close(() => resolve())))
  )
  vi.restoreAllMocks()
})

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-ws-fallback-'))
}

function fallbackFile(userDataPath: string): string {
  return join(userDataPath, FALLBACK_PORT_FILE)
}

function seedFallback(userDataPath: string, port: number): void {
  writeFileSync(fallbackFile(userDataPath), JSON.stringify({ port }), 'utf8')
}

async function reserveFreePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', () => resolve()))
  const { port } = socket.address() as AddressInfo
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

async function holdPort(port: number): Promise<Server> {
  const socket = createServer()
  heldSockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(port, '127.0.0.1', () => resolve())
  })
  return socket
}

async function releasePort(socket: Server): Promise<void> {
  heldSockets.splice(heldSockets.indexOf(socket), 1)
  await new Promise<void>((resolve) => socket.close(() => resolve()))
}

// Why: reproduce a host that refuses one specific port (Windows Hyper-V excluded range) without needing one.
function blockListen(
  isBlocked: (port: number) => boolean,
  makeError: (port: number) => Error
): () => void {
  const prototype = WebSocketTransport.prototype as unknown as {
    tryListen: (port: number) => Promise<void>
  }
  const original = prototype.tryListen
  prototype.tryListen = function (port: number): Promise<void> {
    return isBlocked(port) ? Promise.reject(makeError(port)) : original.call(this, port)
  }
  return () => {
    prototype.tryListen = original
  }
}

function listenDenied(port: number): Error {
  return Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), {
    code: 'EACCES',
    syscall: 'listen',
    port
  })
}

async function startRuntime(options: {
  userDataPath: string
  wsPort: number
  preferPinnedWsPort?: boolean
}): Promise<OrcaRuntimeRpcServer> {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: options.userDataPath,
    enableWebSocket: true,
    wsPort: options.wsPort,
    preferPinnedWsPort: options.preferPinnedWsPort
  })
  await server.start()
  return server
}

function servedPort(server: OrcaRuntimeRpcServer): number | null {
  const endpoint = server.getWebSocketEndpoint()
  return endpoint === null ? null : Number(new URL(endpoint).port)
}

describe('OrcaRuntimeRpcServer persisted WS fallback convergence (STA-4859)', () => {
  it('drops a fallback that failed to bind while the configured port served', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configuredPort = await reserveFreePort()
    const deadFallbackPort = await reserveFreePort()
    seedFallback(userDataPath, deadFallbackPort)
    restoreListen = blockListen((port) => port === deadFallbackPort, listenDenied)

    const server = await startRuntime({ userDataPath, wsPort: configuredPort })
    try {
      expect(servedPort(server)).toBe(configuredPort)
      // Why: the persisted state must converge on what is actually served — keeping the dead fallback is
      // what re-armed it on the next launch and made the advertised endpoint flip-flop.
      expect(existsSync(fallbackFile(userDataPath))).toBe(false)
    } finally {
      await server.stop()
    }

    // Why: the excluded range moved after a reboot, so the old fallback is bindable again. Fallback-first
    // order (STA-1511) would re-take it and strand every device paired to the configured port.
    restoreListen()
    restoreListen = null
    const relaunched = await startRuntime({ userDataPath, wsPort: configuredPort })
    try {
      expect(servedPort(relaunched)).toBe(configuredPort)
      expect(existsSync(fallbackFile(userDataPath))).toBe(false)
    } finally {
      await relaunched.stop()
    }
  })

  it('drops a fallback occupied by another process once the configured port serves', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configuredPort = await reserveFreePort()
    const busyFallbackPort = await reserveFreePort()
    const squatter = await holdPort(busyFallbackPort)
    seedFallback(userDataPath, busyFallbackPort)

    const server = await startRuntime({ userDataPath, wsPort: configuredPort })
    try {
      expect(servedPort(server)).toBe(configuredPort)
      expect(existsSync(fallbackFile(userDataPath))).toBe(false)
    } finally {
      await server.stop()
    }

    await releasePort(squatter)
    const relaunched = await startRuntime({ userDataPath, wsPort: configuredPort })
    try {
      expect(servedPort(relaunched)).toBe(configuredPort)
    } finally {
      await relaunched.stop()
    }
  })

  it('keeps a bindable fallback winning over the configured port (STA-1511)', async () => {
    const userDataPath = makeUserDataPath()
    const configuredPort = await reserveFreePort()
    const fallbackPort = await reserveFreePort()
    seedFallback(userDataPath, fallbackPort)

    const server = await startRuntime({ userDataPath, wsPort: configuredPort })
    try {
      // Why: devices paired to the fallback keep reconnecting only while it stays served and persisted.
      expect(servedPort(server)).toBe(fallbackPort)
      expect(readWsFallbackPort(userDataPath)).toBe(fallbackPort)
    } finally {
      await server.stop()
    }
  })

  it('leaves an untried fallback in place when a pinned port wins (#9005)', async () => {
    const userDataPath = makeUserDataPath()
    const pinnedPort = await reserveFreePort()
    const fallbackPort = await reserveFreePort()
    seedFallback(userDataPath, fallbackPort)

    const server = await startRuntime({
      userDataPath,
      wsPort: pinnedPort,
      preferPinnedWsPort: true
    })
    try {
      expect(servedPort(server)).toBe(pinnedPort)
      // Why: pinned-first means the fallback was never attempted, so nothing proves it dead — clearing it
      // here would discard a working endpoint that `orca serve` without --port still hands back to devices.
      expect(readWsFallbackPort(userDataPath)).toBe(fallbackPort)
    } finally {
      await server.stop()
    }
  })

  it('keeps the fallback when a pinned port is busy and the fallback serves (#9005)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const pinnedPort = await reserveFreePort()
    const fallbackPort = await reserveFreePort()
    await holdPort(pinnedPort)
    seedFallback(userDataPath, fallbackPort)

    const server = await startRuntime({
      userDataPath,
      wsPort: pinnedPort,
      preferPinnedWsPort: true
    })
    try {
      expect(servedPort(server)).toBe(fallbackPort)
      expect(readWsFallbackPort(userDataPath)).toBe(fallbackPort)
    } finally {
      await server.stop()
    }
  })

  it('never touches the store when the port is OS-assigned (wsPort 0, E2E)', async () => {
    const userDataPath = makeUserDataPath()
    const seeded = '{"port":54321}'
    writeFileSync(fallbackFile(userDataPath), seeded, 'utf8')

    const server = await startRuntime({ userDataPath, wsPort: 0 })
    try {
      expect(servedPort(server)).not.toBe(0)
      expect(readFileSync(fallbackFile(userDataPath), 'utf8')).toBe(seeded)
    } finally {
      await server.stop()
    }
  })

  it('leaves the store untouched when the WebSocket transport fails to start', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configuredPort = await reserveFreePort()
    const fallbackPort = await reserveFreePort()
    const seeded = JSON.stringify({ port: fallbackPort })
    writeFileSync(fallbackFile(userDataPath), seeded, 'utf8')
    // Why: a non-listen EACCES is not a fall-through candidate error, so the configured port rethrows and
    // the whole WS start fails — a failed bind must never mutate what the next launch will trust.
    restoreListen = blockListen(
      () => true,
      () => Object.assign(new Error('open EACCES'), { code: 'EACCES', syscall: 'open' })
    )

    const server = await startRuntime({ userDataPath, wsPort: configuredPort })
    try {
      expect(server.getWebSocketEndpoint()).toBeNull()
      expect(readFileSync(fallbackFile(userDataPath), 'utf8')).toBe(seeded)
    } finally {
      await server.stop()
    }
  })

  it('persists an OS-assigned port when the configured port is taken and re-binds it next launch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataPath = makeUserDataPath()
    const configuredPort = await reserveFreePort()
    const firstInstance = await holdPort(configuredPort)

    const server = await startRuntime({ userDataPath, wsPort: configuredPort })
    let assignedPort: number | null = null
    try {
      assignedPort = servedPort(server)
      expect(assignedPort).not.toBe(configuredPort)
      expect(readWsFallbackPort(userDataPath)).toBe(assignedPort)
    } finally {
      await server.stop()
    }

    await releasePort(firstInstance)
    const relaunched = await startRuntime({ userDataPath, wsPort: configuredPort })
    try {
      // Why: STA-1511 stability — the freed configured port must not steal the endpoint devices paired to.
      expect(servedPort(relaunched)).toBe(assignedPort)
      expect(readWsFallbackPort(userDataPath)).toBe(assignedPort)
    } finally {
      await relaunched.stop()
    }
  })
})
