// Runs real relay daemons on the host that runs the test, so socket-ownership
// claims are settled by actual processes rather than by mocked exec output.
//
// Needs `pnpm build:relay` — callers skip when relayBundleDirForHost() is null.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { SshConnection } from './ssh-connection'

const FRAME_HEADER_BYTES = 13
const MESSAGE_TYPE_REGULAR = 1

export function relayBundleDirForHost(repoRoot: string): string | null {
  const dir = join(repoRoot, 'out', 'relay', `${process.platform}-${process.arch}`)
  return existsSync(join(dir, 'relay.js')) ? dir : null
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class LiveRelayFixture {
  readonly sockPath: string
  readonly credentialFile: string
  private readonly children = new Set<ChildProcess>()
  private readonly daemonPids = new Set<number>()

  constructor(
    readonly relayDir: string,
    bundleDir: string,
    repoRoot: string
  ) {
    mkdirSync(relayDir, { recursive: true })
    cpSync(bundleDir, relayDir, { recursive: true })
    // Why: node-pty is external to the relay bundle and must resolve beside relay.js.
    symlinkSync(join(repoRoot, 'node_modules'), join(relayDir, 'node_modules'))
    this.sockPath = join(relayDir, 'relay-ownership.sock')
    this.credentialFile = join(relayDir, 'relay-ownership.credential')
    writeFileSync(this.credentialFile, randomBytes(32).toString('base64url'), { mode: 0o600 })
  }

  /** Launch a detached daemon exactly as ssh-relay-deploy does: --detached --grace-time 0. */
  launchDaemon(label: string): ChildProcess {
    const child = spawn(
      process.execPath,
      [
        join(this.relayDir, 'relay.js'),
        '--detached',
        '--grace-time',
        '0',
        '--sock-path',
        this.sockPath,
        '--credential-file',
        this.credentialFile,
        '--log-file',
        join(this.relayDir, `relay-${label}.log`)
      ],
      {
        cwd: this.relayDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ORCA_DISABLE_MACOS_LOGIN_SHELL: '1' }
      }
    )
    child.unref()
    if (child.pid) {
      this.daemonPids.add(child.pid)
    }
    this.children.add(child)
    return child
  }

  /** 'READY' when a listener accepted, otherwise the connect error code. */
  connectProbe(): Promise<string> {
    return new Promise((resolve) => {
      const sock = connect(this.sockPath)
      sock.once('connect', () => {
        sock.destroy()
        resolve('READY')
      })
      sock.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'ERROR'))
    })
  }

  async waitForSocket(timeoutMs = 20_000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if ((await this.connectProbe()) === 'READY') {
        return true
      }
      await delay(100)
    }
    return false
  }

  openBridge(): RelayBridge {
    const bridge = new RelayBridge(this.relayDir, this.sockPath, this.credentialFile)
    this.children.add(bridge.process)
    return bridge
  }

  dispose(): void {
    for (const child of this.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    for (const pid of this.daemonPids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

/** A `relay.js --connect` bridge, driven over its stdio like the SSH exec channel does. */
export class RelayBridge {
  readonly process: ChildProcess
  private buffer = Buffer.alloc(0)
  private sentinelSeen = false
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >()

  constructor(relayDir: string, sockPath: string, credentialFile: string) {
    this.process = spawn(
      process.execPath,
      [
        join(relayDir, 'relay.js'),
        '--connect',
        '--sock-path',
        sockPath,
        '--credential-file',
        credentialFile
      ],
      { cwd: relayDir, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    this.process.stderr?.resume()
    this.process.stdout?.on('data', (chunk: Buffer) => this.ingest(chunk))
  }

  private ingest(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.sentinelSeen) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      this.sentinelSeen = true
      this.buffer = this.buffer.subarray(newline + 1)
    }
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(9)
      if (this.buffer.length < FRAME_HEADER_BYTES + length) {
        return
      }
      const type = this.buffer[0]
      const payload = this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length)
      if (type !== MESSAGE_TYPE_REGULAR) {
        continue
      }
      let message: { id?: number; result?: unknown; error?: unknown }
      try {
        message = JSON.parse(payload.toString('utf-8'))
      } catch {
        continue
      }
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id)
      if (!waiter || message.id === undefined) {
        continue
      }
      this.pending.delete(message.id)
      if (message.error) {
        waiter.reject(new Error(JSON.stringify(message.error)))
      } else {
        waiter.resolve(message.result as never)
      }
    }
  }

  async waitForSentinel(timeoutMs = 20_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (this.sentinelSeen) {
        return
      }
      await delay(50)
    }
    throw new Error('relay --connect never emitted its sentinel')
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf-8')
    const header = Buffer.alloc(FRAME_HEADER_BYTES)
    header[0] = MESSAGE_TYPE_REGULAR
    header.writeUInt32BE(0, 1)
    header.writeUInt32BE(0, 5)
    header.writeUInt32BE(payload.length, 9)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: ((value: T) => {
          clearTimeout(timer)
          resolve(value)
        }) as (value: never) => void,
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.process.stdin?.write(Buffer.concat([header, payload]))
    })
  }

  close(): void {
    this.process.kill('SIGKILL')
  }
}

/**
 * An SshConnection whose exec runs on this machine, so production command
 * strings and production execCommand parsing are both exercised for real.
 */
export function createLocalShellConnection(): SshConnection {
  return {
    usesSystemSshTransport: () => false,
    canRunConcurrentExecCommands: () => true,
    exec: (command: string) => Promise.resolve(createLocalShellChannel(command))
  } as unknown as SshConnection
}

function createLocalShellChannel(command: string): EventEmitter & {
  stderr: EventEmitter
  close: () => void
  resume: () => void
} {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter & { resume: () => void }
    close: () => void
    resume: () => void
  }
  const stderr = new EventEmitter() as EventEmitter & { resume: () => void }
  stderr.resume = (): void => {}
  channel.stderr = stderr
  channel.resume = (): void => {}
  const child = spawn('/bin/sh', ['-c', command])
  channel.close = (): void => {
    child.kill('SIGKILL')
  }
  child.stdout.on('data', (chunk: Buffer) => channel.emit('data', chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.emit('data', chunk))
  child.on('error', (error: Error) => channel.emit('error', error))
  child.on('close', (code: number | null) => channel.emit('close', code ?? 0))
  return channel
}
