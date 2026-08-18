// The STA-1756 journey, end to end, through the production launch path.
//
// Everything here is real: a detached relay daemon holding a real PTY, a real `--connect`
// bridge that the daemon refuses, and the shipping `launchRelay` deciding what to do about
// the socket. The only substitution is the SSH transport, which runs the same command
// strings through a local shell.
//
// Before this change that decision was "unlink the socket and start a replacement", which
// left the incumbent alive, unreachable, and holding the user's shell forever.
//
// Requires `pnpm build:relay`; the relay_socket_ownership CI job builds it first.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { launchRelay } from './ssh-relay-deploy'
import {
  LiveRelayFixture,
  createLocalShellConnection,
  isProcessAlive,
  relayBundleDirForHost
} from './ssh-relay-live-daemon-harness'
import { isRelaySocketOwnerLiveError } from './ssh-relay-socket-owner'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const REPO_ROOT = process.cwd()
const BUNDLE_DIR = relayBundleDirForHost(REPO_ROOT)
const TARGET_ID = 'sta-1756-live-journey'

if (process.env.ORCA_REQUIRE_RELAY_BUNDLE === '1' && !BUNDLE_DIR) {
  throw new Error(
    `No relay bundle at out/relay/${process.platform}-${process.arch}; run pnpm build:relay first.`
  )
}

type RelayStatus = { pid: number; ptys: { active: number } }

describe.skipIf(!BUNDLE_DIR || process.platform === 'win32')('launchRelay socket ownership', () => {
  let fixture: LiveRelayFixture | null = null
  let root: string | null = null

  afterEach(async () => {
    await fixture?.dispose()
    fixture = null
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = null
    }
  })

  it('refuses to displace a live relay whose reconnect it cannot complete', async () => {
    // Why the short prefix: sun_path caps a Unix socket at 104 bytes on macOS.
    root = mkdtempSync(join(tmpdir(), 'orca-rel-'))
    const live = new LiveRelayFixture(root, BUNDLE_DIR!, REPO_ROOT, TARGET_ID)
    fixture = live
    live.launchDaemon('incumbent')
    expect(await live.waitForSocket()).toBe(true)

    const bridge = live.openBridge()
    await bridge.waitForSentinel()
    await bridge.request('pty.spawn', { cwd: root, cols: 80, rows: 24 })
    const incumbent = await bridge.request<RelayStatus>('relay.status')
    expect(incumbent.ptys.active).toBe(1)
    const mark = live.logMark('incumbent')
    bridge.close()
    await live.waitForClientDisconnect('incumbent', mark)

    // Why rotate the credential: the daemon read it at startup and keeps it for life, so
    // this is the real shape of a reconnect a healthy relay refuses — an interrupted deploy
    // that rewrote the file after the daemon had already claimed the socket.
    live.rotateCredential()

    const hostPlatform = getRemoteHostPlatform(
      process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64'
    )
    const error = await launchRelay(
      createLocalShellConnection(),
      root,
      hostPlatform,
      process.execPath,
      0,
      TARGET_ID
    ).catch((err) => err)

    expect(isRelaySocketOwnerLiveError(error)).toBe(true)
    // The incumbent still owns its socket and its shell, and nothing was started over it.
    expect(existsSync(live.sockPath)).toBe(true)
    expect(isProcessAlive(incumbent.pid)).toBe(true)
    expect(live.logMark('replacement')).toBe(0)
  })
})
