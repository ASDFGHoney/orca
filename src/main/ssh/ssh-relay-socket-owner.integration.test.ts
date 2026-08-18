// STA-1756 oracle, run against real relay daemons rather than mocked exec output.
//
// The reported defect: a failed `--connect` unlinked the relay socket and launched a
// fresh detached relay over the same path. Unlinking cannot stop a daemon that already
// bound that path, so the old relay stayed alive forever with its PTYs and every agent
// inside them — invisible to the app, and never reaped (`--grace-time 0` arms no timer
// while a PTY is held).
//
// The control case below is latest-main's behaviour: it performs the raw `rm -f` and
// asserts the orphan appears. The guarded case asserts removeUnownedRelaySocket refuses
// the same displacement, which restores the relay's own EADDRINUSE interlock.
//
// Requires `pnpm build:relay`; skipped when the bundle for this host is absent.

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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
import {
  isRelaySocketOwnerLiveError,
  probeRelaySocketOwner,
  removeUnownedRelaySocket
} from './ssh-relay-socket-owner'

const REPO_ROOT = process.cwd()
const BUNDLE_DIR = relayBundleDirForHost(REPO_ROOT)

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
    root = mkdtempSync(join(tmpdir(), 'orca-relay-ownership-'))
    const live = new LiveRelayFixture(join(root, 'relay'), BUNDLE_DIR!, REPO_ROOT)
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
    bridge.close()
    await delay(500)
    return { fixture: live, pid: status.pid }
  }

  it('reports a daemon that is listening as live, and a socket nobody holds as exited', async () => {
    const { fixture: live, pid } = await startRelayHoldingAPty()
    const conn = createLocalShellConnection()

    await expect(probeRelaySocketOwner(conn, process.execPath, live.sockPath)).resolves.toBe('live')

    // A crashed relay leaves the inode behind; that, and only that, is a stale socket.
    killProcessTree(pid)
    await delay(500)
    expect(existsSync(live.sockPath)).toBe(true)
    await expect(probeRelaySocketOwner(conn, process.execPath, live.sockPath)).resolves.toBe(
      'exited'
    )
  })

  it('refuses to unlink the socket of a relay that still holds a PTY', async () => {
    const { fixture: live, pid } = await startRelayHoldingAPty()
    const conn = createLocalShellConnection()

    await expect(removeUnownedRelaySocket(conn, process.execPath, live.sockPath)).rejects.toSatisfy(
      isRelaySocketOwnerLiveError
    )

    expect(existsSync(live.sockPath)).toBe(true)
    expect(isProcessAlive(pid)).toBe(true)

    // The socket kept its owner, so a fresh daemon hits EADDRINUSE, finds a live
    // listener, and refuses to start — the interlock the unconditional rm -f defeated.
    const replacement = live.launchDaemon('replacement')
    expect(await waitForExit(replacement)).not.toBe(0)
    const bridge = live.openBridge()
    await bridge.waitForSentinel()
    const status = await bridge.request<RelayStatus>('relay.status')
    expect(status.pid).toBe(pid)
    expect(status.ptys.active).toBe(1)
    bridge.close()
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
