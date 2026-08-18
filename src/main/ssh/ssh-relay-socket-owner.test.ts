import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false
}))

import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  isRelaySocketOwnerLiveError,
  parseRelaySocketOwnerProbe,
  probeRelaySocketOwner,
  relaySocketOwnerProbeCommand,
  removeUnownedRelaySocket
} from './ssh-relay-socket-owner'

const SOCK = '/home/u/.orca-remote/relay-0.1.0+abc/relay-deadbeef.sock'
const NODE = '/usr/bin/node'
const conn = {} as SshConnection

function commands(): string[] {
  return vi.mocked(execCommand).mock.calls.map(([, command]) => command)
}

describe('relay socket owner probe', () => {
  beforeEach(() => {
    vi.mocked(execCommand).mockReset()
  })

  it('probes by connecting, not by testing the inode', () => {
    const command = relaySocketOwnerProbeCommand(NODE, SOCK)
    expect(command).toContain('net')
    expect(command).toContain('connect')
    // Why: `test -S` is what the deploy probe already does, and it cannot tell a
    // listening owner from an inode a crashed relay left behind.
    expect(command).not.toContain('test -S')
    expect(command).toContain(`'${SOCK}'`)
  })

  it('reads ECONNREFUSED and ENOENT as the only proof of an absent owner', () => {
    expect(parseRelaySocketOwnerProbe('LIVE')).toBe('live')
    expect(parseRelaySocketOwnerProbe('EXITED\n')).toBe('exited')
    expect(parseRelaySocketOwnerProbe('UNVERIFIABLE')).toBe('unverifiable')
  })

  it('refuses to guess from ambiguous or empty probe output', () => {
    expect(parseRelaySocketOwnerProbe('')).toBe('unverifiable')
    expect(parseRelaySocketOwnerProbe('LIVE\nEXITED')).toBe('unverifiable')
    expect(parseRelaySocketOwnerProbe('command not found: node')).toBe('unverifiable')
  })

  it('answers unverifiable when the probe cannot run at all', async () => {
    vi.mocked(execCommand).mockRejectedValueOnce(new Error('channel open failure'))
    await expect(probeRelaySocketOwner(conn, NODE, SOCK)).resolves.toBe('unverifiable')
  })

  it('propagates an abort instead of reporting a verdict', async () => {
    const controller = new AbortController()
    vi.mocked(execCommand).mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(new Error('aborted'))
    })
    await expect(probeRelaySocketOwner(conn, NODE, SOCK, controller.signal)).rejects.toThrow()
  })
})

describe('removeUnownedRelaySocket', () => {
  beforeEach(() => {
    vi.mocked(execCommand).mockReset()
  })

  it('removes the socket once the probe proves nothing is listening', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('EXITED').mockResolvedValueOnce('')

    await removeUnownedRelaySocket(conn, NODE, SOCK)

    expect(commands()[1]).toBe(`rm -f '${SOCK}'`)
  })

  it('leaves the socket of a live owner in place', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('LIVE')

    await expect(removeUnownedRelaySocket(conn, NODE, SOCK)).rejects.toSatisfy(
      isRelaySocketOwnerLiveError
    )

    expect(commands().some((command) => command.startsWith('rm -f'))).toBe(false)
  })

  it('leaves the socket in place when ownership is merely unverifiable', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('UNVERIFIABLE')

    await expect(removeUnownedRelaySocket(conn, NODE, SOCK)).rejects.toSatisfy(
      isRelaySocketOwnerLiveError
    )

    expect(commands().some((command) => command.startsWith('rm -f'))).toBe(false)
  })

  it('rethrows an unconfirmed removal so no fresh relay launches over it', async () => {
    const unconfirmed = Object.assign(new Error('socket cleanup still running'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(execCommand).mockResolvedValueOnce('EXITED').mockRejectedValueOnce(unconfirmed)

    await expect(removeUnownedRelaySocket(conn, NODE, SOCK)).rejects.toBe(unconfirmed)
  })

  it('names the socket and the recovery action in the error', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('LIVE')
    const cause = new Error('handshake refused')

    const error = await removeUnownedRelaySocket(conn, NODE, SOCK, { cause }).catch((err) => err)

    expect(error.sockPath).toBe(SOCK)
    expect(error.verdict).toBe('live')
    expect(error.cause).toBe(cause)
    expect(error.message).toContain('Reset remote relay')
  })
})
