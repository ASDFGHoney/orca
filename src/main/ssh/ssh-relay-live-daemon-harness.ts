// Runs real relay daemons on the host that runs the test, so socket-ownership
// claims are settled by actual processes rather than by mocked exec output.
//
// Needs `pnpm build:relay` — callers skip when relayBundleDirForHost() is null.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { RelayBridge } from './ssh-relay-bridge-client'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { SshConnection } from './ssh-connection'

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

/**
 * SIGKILL a process and every descendant, deepest first.
 *
 * Why: a relay killed on its own leaves its PTY shells reparented to init — the very
 * leak these tests are about, reproduced on the machine running them.
 */
export function killProcessTree(pid: number): void {
  const listing = spawnSync('ps', ['-eo', 'pid=,ppid=']).stdout?.toString() ?? ''
  const childrenByParent = new Map<number, number[]>()
  for (const line of listing.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(child) && Number.isInteger(parent)) {
      childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), child])
    }
  }
  const ordered: number[] = []
  const visit = (current: number): void => {
    for (const child of childrenByParent.get(current) ?? []) {
      visit(child)
    }
    ordered.push(current)
  }
  visit(pid)
  for (const target of ordered) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

export function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<number | null> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay daemon never exited')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

export class LiveRelayFixture {
  readonly sockPath: string
  readonly credentialFile: string
  private readonly bridges = new Set<ChildProcess>()
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
    // Why not tracked as a bridge child: bridges are SIGKILLed on teardown, and a daemon
    // killed that way never runs the SIGTERM shutdown that disposes its PTYs.
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
    this.bridges.add(bridge.process)
    return bridge
  }

  /** Ask each daemon to shut down (which disposes its PTYs), then kill whatever is left. */
  async dispose(): Promise<void> {
    for (const bridge of this.bridges) {
      try {
        bridge.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    for (const pid of this.daemonPids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    for (let attempt = 0; attempt < 50 && [...this.daemonPids].some(isProcessAlive); attempt++) {
      await delay(100)
    }
    // Why a tree kill as the fallback: a daemon that ignored SIGTERM still owns PTY shells,
    // and killing it alone would reparent them to init — the leak these tests are about.
    for (const pid of this.daemonPids) {
      killProcessTree(pid)
    }
  }

  /** Resolve once the daemon's log records that its last client went away. */
  async waitForClientDisconnect(label: string, timeoutMs = 20_000): Promise<void> {
    const logPath = join(this.relayDir, `relay-${label}.log`)
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : ''
      if (log.includes('Socket client closed (clients=0)')) {
        return
      }
      await delay(50)
    }
    throw new Error(`relay ${label} never reported its last client closing`)
  }
}

/**
 * An SshConnection whose exec runs on this machine, so production command
 * strings and production execCommand parsing are both exercised for real.
 */
export function createLocalShellConnection(options?: { path?: string }): SshConnection {
  return {
    usesSystemSshTransport: () => false,
    canRunConcurrentExecCommands: () => true,
    exec: (command: string) => Promise.resolve(createLocalShellChannel(command, options?.path))
  } as unknown as SshConnection
}

/** `path` overrides PATH, so a caller can model a host without lsof or pgrep. */
function createLocalShellChannel(
  command: string,
  path?: string
): EventEmitter & {
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
  const child = spawn('/bin/sh', ['-c', command], {
    env: path === undefined ? process.env : { ...process.env, PATH: path }
  })
  channel.close = (): void => {
    child.kill('SIGKILL')
  }
  child.stdout.on('data', (chunk: Buffer) => channel.emit('data', chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.emit('data', chunk))
  child.on('error', (error: Error) => channel.emit('error', error))
  child.on('close', (code: number | null) => channel.emit('close', code ?? 0))
  return channel
}
