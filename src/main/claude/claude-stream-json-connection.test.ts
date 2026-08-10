import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { spawn } from 'node:child_process'
import {
  openClaudeStreamJsonConnection,
  type ClaudeControlRequest
} from './claude-stream-json-connection'

type FakeChild = EventEmitter & {
  pid: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function fakeSpawn() {
  const child = new EventEmitter() as FakeChild
  child.pid = 4321
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  const spawnImpl = vi.fn(() => child) as unknown as typeof spawn
  return { child, spawnImpl }
}

function writtenFrames(child: FakeChild): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    setImmediate(() => {
      const text = child.stdin.read()?.toString('utf8') ?? ''
      resolve(
        text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      )
    })
  })
}

describe('Claude stream-json connection', () => {
  it('spawns in the pinned workspace and routes acknowledged control requests', async () => {
    const process = fakeSpawn()
    const connection = await openClaudeStreamJsonConnection(
      {
        command: 'claude',
        args: ['-p'],
        cwd: '/work/repo',
        env: { CLAUDE_CONFIG_DIR: '/accounts/one' }
      },
      {},
      process.spawnImpl
    )
    const listing = connection.request('list_models')
    const outbound = await writtenFrames(process.child)
    const requestId = (outbound[0] as { request_id: string }).request_id
    process.child.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { models: [{ value: 'sonnet' }] }
        }
      })}\n`
    )

    await expect(listing).resolves.toEqual({ models: [{ value: 'sonnet' }] })
    expect(process.spawnImpl).toHaveBeenCalledWith(
      'claude',
      ['-p'],
      expect.objectContaining({
        cwd: '/work/repo',
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/accounts/one' }),
        windowsHide: true
      })
    )
  })

  it('routes provider permission controls and writes their response envelope', async () => {
    const process = fakeSpawn()
    let inbound: ClaudeControlRequest | null = null
    const connection = await openClaudeStreamJsonConnection(
      { command: 'claude', args: [], cwd: '/work' },
      { onControlRequest: (request) => (inbound = request) },
      process.spawnImpl
    )
    process.child.stdout.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'permission-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash' }
      })}\n`
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(inbound).toMatchObject({ request_id: 'permission-1' })

    await connection.respond('permission-1', { behavior: 'deny', message: 'No' })
    expect(await writtenFrames(process.child)).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'permission-1',
          response: { behavior: 'deny', message: 'No' }
        }
      }
    ])
  })

  it('fails closed on malformed provider output', async () => {
    const process = fakeSpawn()
    const onExit = vi.fn()
    await openClaudeStreamJsonConnection(
      { command: 'claude', args: [], cwd: '/work' },
      { onExit },
      process.spawnImpl
    )
    process.child.stdout.write('{not-json}\n')
    await new Promise((resolve) => setImmediate(resolve))

    expect(process.child.kill).toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }))
  })
})
