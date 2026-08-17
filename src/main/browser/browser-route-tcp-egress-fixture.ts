import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from './browser-local-https-test-certificate'
import { runBrowserRouteTcpEgressElectron } from './browser-route-tcp-egress-electron-process'
import { createBrowserRouteTcpEgressSocksRecorder } from './browser-route-tcp-egress-socks-recorder'

const REMOTE_HOST = 'remote-browser.test'

type TargetObservation = Readonly<{ path: string; remotePort: number }>

export type BrowserRouteTcpEgressProbeResult = {
  resolvedProxy: string
  directPaths: string[]
  routedPaths: string[]
  socksHosts: string[]
}

export async function runBrowserRouteTcpEgressProbe(
  protectedSession: boolean
): Promise<BrowserRouteTcpEgressProbeResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-tcp-egress-'))
  const observations: TargetObservation[] = []
  const routedSourcePorts = new Set<number>()
  const socksHosts = new Set<string>()
  const sockets = new Set<Socket>()
  const http = createHttpTarget(observations)
  const https = createHttpsTarget(observations)
  const webSocket = attachWebSocketTarget(http, observations)
  let socks: Server | null = null
  let result: BrowserRouteTcpEgressProbeResult | null = null
  let primaryFailure: unknown = null
  try {
    const [httpPort, httpsPort] = await Promise.all([listen(http, sockets), listen(https, sockets)])
    socks = createBrowserRouteTcpEgressSocksRecorder(
      new Set([httpPort, httpsPort]),
      routedSourcePorts,
      socksHosts,
      sockets
    )
    const socksPort = await listen(socks, sockets)
    const mainPath = join(root, 'main.cjs')
    const resultPath = join(root, 'result.json')
    writeFileSync(mainPath, electronMain())
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ httpPort, httpsPort, protectedSession, resultPath, socksPort })
    )
    const resolvedProxy = await runBrowserRouteTcpEgressElectron(root, mainPath)
    const classified = classifyObservations(observations, routedSourcePorts)
    result = { resolvedProxy, ...classified, socksHosts: [...socksHosts].sort() }
  } catch (error) {
    primaryFailure = error
  }
  const cleanupFailures = await cleanup(root, [socks, https, http], webSocket, sockets)
  if (primaryFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
      primaryFailure instanceof Error ? primaryFailure.message : 'browser_route_tcp_probe_failed'
    )
  }
  if (!result) {
    throw new Error('browser_route_tcp_probe_result_missing')
  }
  return result
}

function electronMain(): string {
  return String.raw`
const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))

app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(true)
})

function waitForDownload(window) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('tcp_probe_download_timeout')), 5000)
    window.webContents.session.once('will-download', (_event, item) => {
      clearTimeout(timeout)
      item.cancel()
      resolve()
    })
    window.webContents.downloadURL('http://' + config.host + ':' + config.httpPort + '/download')
  })
}

async function probe() {
  const partition = 'persist:tcp-egress-' + config.protectedSession + '-' + Date.now()
  const routeSession = session.fromPartition(partition, { cache: false })
  routeSession.setCertificateVerifyProc((_request, callback) => callback(0))
  if (config.protectedSession) {
    await routeSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:' + config.socksPort,
      proxyBypassRules: '<-loopback>'
    })
    await routeSession.closeAllConnections()
  }
  const resolvedProxy = await routeSession.resolveProxy('http://' + config.host + '/')
  const window = new BrowserWindow({
    show: false,
    webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true }
  })
  await window.loadURL('http://' + config.host + ':' + config.httpPort + '/redirect')
  await window.webContents.executeJavaScript(
    "new Promise((resolve, reject) => { const image = document.querySelector('img'); if (image.complete) return resolve(true); image.addEventListener('load', () => resolve(true), { once: true }); image.addEventListener('error', () => reject(new Error('asset failed')), { once: true }) })"
  )
  await window.webContents.executeJavaScript(
    "new Promise((resolve, reject) => { const socket = new WebSocket('ws://" + config.host + ":" + config.httpPort + "/socket'); const timeout = setTimeout(() => reject(new Error('socket timeout')), 5000); socket.addEventListener('message', () => { clearTimeout(timeout); socket.close(); resolve(true) }, { once: true }); socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true }) })"
  )
  await window.webContents.executeJavaScript(
    "fetch('https://" + config.host + ":" + config.httpsPort + "/secure').then(response => { if (!response.ok) throw new Error('secure fetch failed'); return response.text() })"
  )
  await waitForDownload(window)
  window.destroy()
  return resolvedProxy
}

async function run() {
  const timeout = setTimeout(() => app.exit(2), 20000)
  await app.whenReady()
  config.host = config.protectedSession ? '${REMOTE_HOST}' : '127.0.0.1'
  const resolvedProxy = await probe()
  writeFileSync(config.resultPath, JSON.stringify({ resolvedProxy }))
  clearTimeout(timeout)
  app.quit()
}

run().catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String(error?.stack || error) }))
  app.exit(1)
})
`
}

function createHttpTarget(observations: TargetObservation[]): HttpServer {
  return createHttpServer((request, response) => {
    observeRequest(observations, request.url, request.socket.remotePort)
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/page' })
      response.end()
      return
    }
    if (request.url === '/page') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!doctype html><title>TCP probe</title><img src="/asset">')
      return
    }
    if (request.url === '/asset') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
      return
    }
    if (request.url === '/download') {
      response.writeHead(200, {
        'Content-Disposition': 'attachment; filename="probe.txt"',
        'Content-Type': 'text/plain'
      })
      response.end('download probe')
      return
    }
    response.writeHead(404)
    response.end()
  })
}

function createHttpsTarget(observations: TargetObservation[]): HttpServer {
  return createHttpsServer(
    { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE },
    (request, response) => {
      observeRequest(observations, request.url, request.socket.remotePort)
      response.writeHead(request.url === '/secure' ? 200 : 404, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain'
      })
      response.end(request.url === '/secure' ? 'secure probe' : 'not found')
    }
  )
}

function attachWebSocketTarget(
  server: HttpServer,
  observations: TargetObservation[]
): WebSocketServer {
  const webSocket = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    observeRequest(observations, request.url, request.socket.remotePort)
    if (request.url !== '/socket') {
      socket.destroy()
      return
    }
    webSocket.handleUpgrade(request, socket, head, (client) => client.send('ready'))
  })
  return webSocket
}

function observeRequest(
  observations: TargetObservation[],
  path: string | undefined,
  remotePort: number | undefined
): void {
  observations.push({ path: path ?? '', remotePort: remotePort ?? -1 })
}

function classifyObservations(
  observations: TargetObservation[],
  routedSourcePorts: Set<number>
): Pick<BrowserRouteTcpEgressProbeResult, 'directPaths' | 'routedPaths'> {
  const directPaths = new Set<string>()
  const routedPaths = new Set<string>()
  for (const observation of observations) {
    const target = routedSourcePorts.has(observation.remotePort) ? routedPaths : directPaths
    target.add(observation.path)
  }
  return { directPaths: [...directPaths].sort(), routedPaths: [...routedPaths].sort() }
}

function listen(server: Server | HttpServer, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (socket) => trackSocket(socket, sockets))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('browser_route_tcp_probe_listener_unavailable'))
        return
      }
      resolve(address.port)
    })
  })
}

function trackSocket(socket: Socket, sockets: Set<Socket>): void {
  sockets.add(socket)
  socket.on('error', () => socket.destroy())
  socket.once('close', () => sockets.delete(socket))
}

async function cleanup(
  root: string,
  servers: (Server | HttpServer | null)[],
  webSocket: WebSocketServer,
  sockets: Set<Socket>
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const client of webSocket.clients) {
    client.terminate()
  }
  try {
    await new Promise<void>((resolve) => webSocket.close(() => resolve()))
  } catch (error) {
    failures.push(error)
  }
  for (const socket of sockets) {
    socket.destroy()
  }
  for (const server of servers) {
    if (!server?.listening) {
      continue
    }
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    failures.push(error)
  }
  return failures
}
