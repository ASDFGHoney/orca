// STA-1756: a failed --connect used to `rm -f` the relay socket and launch a fresh
// detached relay over the same path. Unlinking cannot stop a relay that already bound
// that path — it only hides the live owner from the fresh launch's EADDRINUSE check,
// so the old relay keeps running forever with its PTYs and every agent inside them.
//
// These pin the shipping wiring: deploy must not remove a socket, and must not launch
// a replacement, unless the owner probe proves nothing is listening.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-endpoint-credential', () => ({
  writeRelayEndpointCredential: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { writeRelayEndpointCredential } from './ssh-relay-endpoint-credential'
import { isRelaySocketOwnerLiveError } from './ssh-relay-socket-owner'
import type { SshConnection } from './ssh-connection'

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

/** Queue the exec replies deploy makes before it decides what to do with an occupied socket. */
function queueDeployUpToOccupiedSocket(): void {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    .mockResolvedValueOnce('') // launch namespace marker
    .mockResolvedValueOnce('ALIVE') // test -S: a socket inode is present
}

function execCommands(): string[] {
  return vi.mocked(execCommand).mock.calls.map(([, command]) => command)
}

function execChannelCommands(conn: SshConnection): string[] {
  return vi.mocked(conn.exec).mock.calls.map(([command]) => command)
}

describe('deployAndLaunchRelay socket displacement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Why: an ordered queue drives the probes below; the default only absorbs the
    // best-effort teardown commands deploy issues after the decision under test.
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(waitForSentinel)
      .mockReset()
      .mockResolvedValue({ write: vi.fn(), onData: vi.fn(), onClose: vi.fn() } as never)
  })

  it('never removes or replaces a socket a live relay still owns', async () => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('relay reconnect refused'))
    queueDeployUpToOccupiedSocket()
    vi.mocked(execCommand).mockResolvedValueOnce('LIVE') // owner probe

    await expect(deployAndLaunchRelay(conn)).rejects.toSatisfy(isRelaySocketOwnerLiveError)

    expect(execCommands().some((command) => command.startsWith('rm -f'))).toBe(false)
    expect(execChannelCommands(conn).some((command) => command.includes('--detached'))).toBe(false)
    // Why: the credential is rotated per fresh launch, so writing one would lock the
    // surviving relay out of every later --connect even if the socket were left alone.
    expect(writeRelayEndpointCredential).not.toHaveBeenCalled()
  })

  it('never removes or replaces a socket whose owner it could not probe', async () => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('relay reconnect refused'))
    queueDeployUpToOccupiedSocket()
    vi.mocked(execCommand).mockResolvedValueOnce('') // owner probe produced no verdict

    await expect(deployAndLaunchRelay(conn)).rejects.toSatisfy(isRelaySocketOwnerLiveError)

    expect(execCommands().some((command) => command.startsWith('rm -f'))).toBe(false)
    expect(execChannelCommands(conn).some((command) => command.includes('--detached'))).toBe(false)
  })

  it('still clears a stale socket whose owner is proven gone', async () => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel)
      .mockRejectedValueOnce(new Error('relay reconnect refused'))
      .mockResolvedValue({ write: vi.fn(), onData: vi.fn(), onClose: vi.fn() } as never)
    queueDeployUpToOccupiedSocket()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('EXITED') // owner probe: connect refused
      .mockResolvedValueOnce('') // rm -f
      .mockResolvedValueOnce('READY') // socket readiness poll

    await expect(deployAndLaunchRelay(conn)).resolves.toMatchObject({ nodePath: '/usr/bin/node' })

    const removals = execCommands().filter((command) => command.startsWith('rm -f'))
    expect(removals).toHaveLength(1)
    expect(removals[0]).toContain('.sock')
    expect(execChannelCommands(conn).some((command) => command.includes('--detached'))).toBe(true)
  })

  // Moved here from ssh-relay-deploy.test.ts: the removal it guards now lives behind the owner probe.
  it('does not launch fresh after unconfirmed stale-socket cleanup', async () => {
    const conn = makeMockConnection()
    const unconfirmedCleanup = Object.assign(new Error('socket cleanup still running'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('stale relay reconnect failed'))
    queueDeployUpToOccupiedSocket()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('EXITED') // owner probe
      .mockRejectedValueOnce(unconfirmedCleanup)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(unconfirmedCleanup)

    expect(execChannelCommands(conn)).toHaveLength(1)
    expect(execChannelCommands(conn).some((command) => command.includes('--detached'))).toBe(false)
  })

  it('probes the socket by connecting to it, not by testing the inode again', async () => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('relay reconnect refused'))
    queueDeployUpToOccupiedSocket()
    vi.mocked(execCommand).mockResolvedValueOnce('LIVE')

    await expect(deployAndLaunchRelay(conn)).rejects.toSatisfy(isRelaySocketOwnerLiveError)

    const ownerProbe = execCommands().at(-1) ?? ''
    expect(ownerProbe).toContain('/usr/bin/node')
    expect(ownerProbe).toContain('connect')
    expect(ownerProbe).not.toContain('test -S')
  })
})
