// Drives a `relay.js --connect` bridge over its stdio, the same surface the SSH exec
// channel gives the app, so tests can speak the relay's JSON-RPC to a live daemon.

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

const FRAME_HEADER_BYTES = 13
const MESSAGE_TYPE_REGULAR = 1

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
    while (!this.sentinelSeen) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      // Why: consume whole lines until the sentinel; a stray pre-sentinel line would
      // otherwise be mistaken for it and desynchronise every frame after it.
      const line = this.buffer.subarray(0, newline).toString('utf-8')
      this.buffer = this.buffer.subarray(newline + 1)
      this.sentinelSeen = line.includes('ORCA-RELAY')
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
