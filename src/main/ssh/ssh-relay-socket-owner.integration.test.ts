// STA-1756 oracle, run against real relay daemons rather than mocked exec output.
//
// The reported defect: a failed `--connect` unlinked the relay socket and launched a
// fresh detached relay over the same path. Unlinking cannot stop a daemon that already
// bound that path, so the old relay stayed alive forever with its PTYs and every agent
// inside them — invisible to the app, and never reaped (`--grace-time 0` arms no timer
// while a PTY is held).
//
// The control case below is latest-main's behaviour: it performs the raw unlink and
// asserts the orphan appears. The guarded case asserts releaseUnownedRelaySocket refuses
// the same displacement, which restores the relay's own EADDRINUSE interlock. Which
// production call site issues that release is pinned separately, by the mocked deploy
// wiring in ssh-relay-socket-displacement.test.ts.
//
// Requires `pnpm build:relay`; the CI job that runs this file builds it first.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LiveRelayFixture,
  createLocalShellConnection,
  delay,
  isProcessAlive,
  killProcessTree,
  relayBundleDirForHost,
  waitForExit
} from './ssh-relay-live-daemon-harness'
import { isRelaySocketOwnerLiveError, releaseUnownedRelaySocket } from './ssh-relay-socket-owner'

const REPO_ROOT = process.cwd()
const BUNDLE_DIR = relayBundleDirForHost(REPO_ROOT)

// Why: skipping is right on a developer machine that never ran `pnpm build:relay`, and
// wrong in the CI job that exists to run this file — there a skip is green with no daemon
// ever started. The job sets this so the missing bundle fails instead.
if (process.env.ORCA_REQUIRE_RELAY_BUNDLE === '1' && !BUNDLE_DIR) {
  throw new Error(
    `No relay bundle at out/relay/${process.platform}-${process.arch}; run pnpm build:relay first.`
  )
}

type RelayStatus = {
  pid: number
  ptys: { active: number }
  socket: { path: string; owned: boolean; listening: boolean }
}

describe.skipIf(!BUNDLE_DIR || process.platform === 'win32')('relay socket ownership', () => {
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

  async function startRelayHoldingAPty(): Promise<{ fixture: LiveRelayFixture; pid: number }> {
    // Why the short prefix and no nested dir: sun_path caps a Unix socket at 104 bytes on
    // macOS, and this machine's tmpdir already spends 62 of them.
    root = mkdtempSync(join(tmpdir(), 'orca-rel-'))
    const live = new LiveRelayFixture(root, BUNDLE_DIR!, REPO_ROOT)
    fixture = live
    live.launchDaemon('incumbent')
    expect(await live.waitForSocket()).toBe(true)

    const bridge = live.openBridge()
    await bridge.waitForSentinel()
    await bridge.request('pty.spawn', { cwd: root, cols: 80, rows: 24 })
    const status = await bridge.request<RelayStatus>('relay.status')
    expect(status.ptys.active).toBe(1)
    // Why: the app walking away is what starts the incumbent's grace window; with
    // --grace-time 0 and a live PTY that window arms no timer, so nothing reaps it.
    const mark = live.logMark('incumbent')
    bridge.close()
    await live.waitForClientDisconnect('incumbent', mark)
    return { fixture: live, pid: status.pid }
  }

  async function waitForDeath(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 50 && isProcessAlive(pid); attempt++) {
      await delay(100)
    }
    expect(isProcessAlive(pid)).toBe(false)
  }

  it('releases the socket of a relay that is really gone', async () => {
    const { fixture: live, pid } = await startRelayHoldingAPty()
    const conn = createLocalShellConnection()

    // A crashed relay leaves the inode behind; that, and only that, is a stale socket.
    killProcessTree(pid)
    await waitForDeath(pid)
    expect(existsSync(live.sockPath)).toBe(true)

    await expect(
      releaseUnownedRelaySocket(conn, process.execPath, live.sockPath)
    ).resolves.toBeUndefined()

    expect(existsSync(live.sockPath)).toBe(false)
  })

  it('refuses to release the socket of a relay that still holds a PTY', async () => {
    const { fixture: live, pid } = await startRelayHoldingAPty()
    const conn = createLocalShellConnection()

    await expect(
      releaseUnownedRelaySocket(conn, process.execPath, live.sockPath)
    ).rejects.toSatisfy(isRelaySocketOwnerLiveError)

    expect(existsSync(live.sockPath)).toBe(true)
    expect(isProcessAlive(pid)).toBe(true)

    // The socket kept its owner, so a fresh daemon hits EADDRINUSE, finds a live
    // listener, and refuses to start — the interlock the unconditional unlink defeated.
    const replacement = live.launchDaemon('replacement')
    expect(await waitForExit(replacement)).not.toBe(0)
    const bridge = live.openBridge()
    await bridge.waitForSentinel()
    const status = await bridge.request<RelayStatus>('relay.status')
    expect(status.pid).toBe(pid)
    expect(status.ptys.active).toBe(1)
    bridge.close()
  })

  it('still sees a live owner on a host with no lsof', async () => {
    const { fixture: live, pid } = await startRelayHoldingAPty()
    // Why: minimal hosts ship neither lsof nor pgrep, so the connect probe is the only
    // owner evidence there — and it is the branch that must never mistake a live daemon
    // for a stale inode.
    const conn = createLocalShellConnection({ path: '' })

    await expect(
      releaseUnownedRelaySocket(conn, process.execPath, live.sockPath)
    ).rejects.toSatisfy(isRelaySocketOwnerLiveError)

    expect(existsSync(live.sockPath)).toBe(true)
    expect(isProcessAlive(pid)).toBe(true)
  })

  it('control: unlinking first orphans the incumbent relay and its PTY', async () => {
    const { fixture: live, pid } = await startRelayHoldingAPty()

    rmSync(live.sockPath, { force: true })
    live.launchDaemon('replacement')
    expect(await live.waitForSocket()).toBe(true)
    const bridge = live.openBridge()
    await bridge.waitForSentinel()
    const status = await bridge.request<RelayStatus>('relay.status')

    // The socket path now answers for a different daemon that owns no PTYs, while the
    // incumbent is still running with the user's shell and no way to ever be reached.
    expect(status.pid).not.toBe(pid)
    expect(status.ptys.active).toBe(0)
    expect(isProcessAlive(pid)).toBe(true)
    bridge.close()
  })
})
