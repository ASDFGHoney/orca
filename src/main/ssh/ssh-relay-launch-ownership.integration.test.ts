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
  delay,
  isProcessAlive,
  killProcessTree,
  relayBundleDirOrFailWhenRequired
} from './ssh-relay-live-daemon-harness'
import { isRelaySocketOwnerLiveError } from './ssh-relay-socket-owner'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const REPO_ROOT = process.cwd()
const BUNDLE_DIR = relayBundleDirOrFailWhenRequired(REPO_ROOT)
const TARGET_ID = 'sta-1756-live-journey'

type RelayStatus = { pid: number; ptys: { active: number } }

const hostPlatform = getRemoteHostPlatform(
  process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64'
)

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

  // Why this pairs with the test above: reset no longer unlinks the socket it stopped, so the
  // inode a killed relay leaves behind has to be the deploy path's problem — and it is.
  it('takes over the socket a killed relay left behind', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-rel-'))
    const live = new LiveRelayFixture(root, BUNDLE_DIR!, REPO_ROOT, TARGET_ID)
    fixture = live
    live.launchDaemon('incumbent')
    expect(await live.waitForSocket()).toBe(true)

    const bridge = live.openBridge()
    await bridge.waitForSentinel()
    const incumbent = await bridge.request<RelayStatus>('relay.status')
    bridge.close()

    // A relay stopped by reset (or a crash) leaves its socket inode behind.
    killProcessTree(incumbent.pid)
    for (let attempt = 0; attempt < 50 && isProcessAlive(incumbent.pid); attempt++) {
      await delay(100)
    }
    expect(existsSync(live.sockPath)).toBe(true)

    const launched = await launchRelay(
      createLocalShellConnection(),
      root,
      hostPlatform,
      process.execPath,
      0,
      TARGET_ID
    )

    expect(launched.sockPath).toBe(live.sockPath)
    const fresh = live.openBridge()
    await fresh.waitForSentinel()
    const status = await fresh.request<RelayStatus>('relay.status')
    expect(status.pid).not.toBe(incumbent.pid)
    fresh.close()
  })
})
