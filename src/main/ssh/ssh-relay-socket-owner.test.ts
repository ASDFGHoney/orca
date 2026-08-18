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
  parseRelaySocketOwnerVerdict,
  relaySocketOwnerProbeCommand,
  requireUnownedRelaySocket
} from './ssh-relay-socket-owner'
import {
  isRelayVersionMismatchError,
  RelayVersionMismatchError
} from './ssh-relay-version-mismatch-error'

const SOCK = '/home/u/.orca-remote/relay-0.1.0+abc/relay-deadbeef.sock'
const NODE = '/usr/bin/node'
const conn = {} as SshConnection

describe('relay socket owner probe command', () => {
  const command = relaySocketOwnerProbeCommand(NODE, SOCK)

  it('proves an owner is present with lsof before falling back to a connect probe', () => {
    expect(command).toContain('lsof -t -a -U "$sock"')
    expect(command).toContain('echo LIVE')
    expect(command).toContain('connect')
    // Why: `test -S` is what the deploy probe already does, and it cannot tell a
    // listening owner from an inode a crashed relay left behind.
    expect(command).not.toContain('test -S')
    expect(command).toContain(`'${SOCK}'`)
  })

  it('only looks, and never removes anything itself', () => {
    // Why: reclaiming the path is the fresh daemon's job, which checks the socket's identity
    // and binds in one process. Unlinking here would put an SSH round-trip between that check
    // and the launch, and a relay that bound the path in between would be the one displaced.
    expect(command).not.toContain('unlinkSync')
    expect(command).not.toContain('rm -f')
  })

  it('retries a refused connect before concluding the path is unowned', () => {
    // Why: a live listener with a momentarily full accept backlog also refuses.
    expect(command).toContain('left=3')
    expect(command).toContain('ECONNREFUSED')
  })

  it('needs an owner inventory, not just refusals, before it may unlink', () => {
    // Why: refusals are an inference. /proc/net/unix, or an lsof proven able to inspect
    // this user's own process, is the evidence — with neither the answer is unverifiable.
    expect(command).toContain('/proc/net/unix')
    expect(command).toContain('lsof -t -p $$')
    expect(command).toContain('proof=none')
  })

  it('compares the pathname column exactly rather than matching a line suffix', () => {
    // Why: a live socket whose own path ends with " " plus ours would match a suffix test,
    // and a path holding regex metacharacters would break an interpolated pattern.
    expect(command).toContain('replace(/^(?:[^ ]+ +){7}/,"")===p')
  })
})

describe('relay socket owner verdict', () => {
  it('reads the host markers', () => {
    expect(parseRelaySocketOwnerVerdict('LIVE')).toBe('live')
    expect(parseRelaySocketOwnerVerdict('EXITED\n')).toBe('exited')
    expect(parseRelaySocketOwnerVerdict('UNVERIFIABLE')).toBe('unverifiable')
  })

  it('refuses to guess from ambiguous or empty output', () => {
    expect(parseRelaySocketOwnerVerdict('')).toBe('unverifiable')
    expect(parseRelaySocketOwnerVerdict('LIVE\nEXITED')).toBe('unverifiable')
    expect(parseRelaySocketOwnerVerdict('command not found: node')).toBe('unverifiable')
  })
})

describe('requireUnownedRelaySocket', () => {
  beforeEach(() => {
    vi.mocked(execCommand).mockReset()
  })

  it('succeeds once the host proves nothing owns the path', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('EXITED')

    await expect(requireUnownedRelaySocket(conn, NODE, SOCK)).resolves.toBeUndefined()
  })

  it('refuses when a live owner still holds the socket', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('LIVE')

    await expect(requireUnownedRelaySocket(conn, NODE, SOCK)).rejects.toSatisfy(
      isRelaySocketOwnerLiveError
    )
  })

  it('refuses when ownership is merely unverifiable', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('UNVERIFIABLE')

    await expect(requireUnownedRelaySocket(conn, NODE, SOCK)).rejects.toSatisfy(
      isRelaySocketOwnerLiveError
    )
  })

  it('refuses when the command could not run at all', async () => {
    vi.mocked(execCommand).mockRejectedValueOnce(new Error('channel open failure'))

    await expect(requireUnownedRelaySocket(conn, NODE, SOCK)).rejects.toSatisfy(
      isRelaySocketOwnerLiveError
    )
  })

  it('propagates an abort instead of reporting an outcome', async () => {
    const controller = new AbortController()
    vi.mocked(execCommand).mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(new Error('aborted'))
    })

    await expect(
      requireUnownedRelaySocket(conn, NODE, SOCK, { signal: controller.signal })
    ).rejects.not.toSatisfy(isRelaySocketOwnerLiveError)
  })

  it('names the socket, the reconnect failure, and the recovery action', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('LIVE')
    const cause = new Error('handshake refused')

    const error = await requireUnownedRelaySocket(conn, NODE, SOCK, { cause }).catch((err) => err)

    expect(error.sockPath).toBe(SOCK)
    expect(error.verdict).toBe('live')
    expect(error.cause).toBe(cause)
    expect(error.message).toContain('handshake refused')
    expect(error.message).toContain('Reset remote relay')
  })
})

describe('terminal causes carried by the owner error', () => {
  it('keeps a wrapped version mismatch classified as terminal', async () => {
    vi.mocked(execCommand).mockReset().mockResolvedValueOnce('LIVE')
    const mismatch = new RelayVersionMismatchError('0.1.0+new', '0.1.0+old')

    const error = await requireUnownedRelaySocket(conn, NODE, SOCK, { cause: mismatch }).catch(
      (err) => err
    )

    // Why: without this the bounded relay-lost backoff would spend six attempts on a
    // version the daemon cannot change, then blame a dropping channel.
    expect(isRelayVersionMismatchError(error)).toBe(true)
  })

  it('does not classify an ordinary reconnect failure as terminal', async () => {
    vi.mocked(execCommand).mockReset().mockResolvedValueOnce('LIVE')

    const error = await requireUnownedRelaySocket(conn, NODE, SOCK, {
      cause: new Error('relay sentinel timeout')
    }).catch((err) => err)

    expect(isRelayVersionMismatchError(error)).toBe(false)
  })
})
