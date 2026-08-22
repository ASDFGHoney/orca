import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PtyBufferSnapshot } from '../pty-transport'
import { createPane } from '../pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection-test-environment'
import { createReattachPayloadHandlers } from './apply-reattach-payload'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

const ALT_OFF = '\x1b[?1049l'
const KITTY_PUSH = '\x1b[>1u'

function createSnapshot(overrides: Partial<PtyBufferSnapshot> = {}): PtyBufferSnapshot {
  return {
    data: 'MODEL-FRAME',
    cols: 120,
    rows: 40,
    source: 'headless',
    alternateScreen: true,
    ...overrides
  }
}

function createSession(): ReattachPayloadSession {
  const pane = createPane(1)
  return {
    pane,
    rememberReattachPayloadAgentSignal: vi.fn(),
    writeReplayData: vi.fn(),
    reattachReplayResetSequence: vi.fn(() => '<reset>'),
    sendFocusedReattachFocusInAfterReplay: vi.fn(),
    applySnapshotKittyKeyboardModes: vi.fn(),
    setRestoredSnapshotBaseline: vi.fn(),
    recordRendererOrderedSeq: vi.fn(),
    isPaneOnAlternateScreen: vi.fn(() => false),
    shouldPreserveAgentReattachModes: vi.fn(() => false),
    kittyKeyboardModes: {
      hasProvenBaseline: true,
      resetForSnapshot: vi.fn(),
      scanReplay: vi.fn()
    }
  } as unknown as ReattachPayloadSession
}

function createContext(
  replay: string,
  fetchSnapshot: () => Promise<PtyBufferSnapshot | null>
): ReattachPayloadContext {
  return {
    isCurrentReattachPayload: () => true,
    connectResult: { id: 'pty-1', replay },
    ptyId: 'pty-1',
    attemptGeneration: 1,
    prefetchedParkModelSnapshot: null,
    revealFollowsTerminalPark: false,
    reconnectMayUseModel: true,
    fetchSshMainModelReattachSnapshot: fetchSnapshot,
    hasStructuralReplay: true,
    coldRestoreStartup: undefined,
    reattachPayloadApplied: false
  }
}

describe('direct SSH reconnect model restore handler', () => {
  beforeEach(() => installTerminalTestGlobals())
  afterEach(async () => restoreTerminalTestGlobals())

  it('paints a compatible full-screen snapshot', async () => {
    const snapshot = createSnapshot()
    const fetchSnapshot = vi.fn(async () => snapshot)
    const session = createSession()

    await createReattachPayloadHandlers(
      session,
      createContext('RELAY-TAIL', fetchSnapshot)
    ).applyReattachPayload()

    expect(fetchSnapshot).toHaveBeenCalledOnce()
    expect(session.rememberReattachPayloadAgentSignal).toHaveBeenCalledWith('MODEL-FRAME', {
      fullScreenReplay: true
    })
    expect(session.setRestoredSnapshotBaseline).toHaveBeenCalledWith('pty-1', snapshot)
  })

  it('skips the snapshot probe when replay proves the app exited alternate screen', async () => {
    const fetchSnapshot = vi.fn(async () => createSnapshot())
    const session = createSession()
    const replay = `${ALT_OFF}\r\n$ `

    await createReattachPayloadHandlers(
      session,
      createContext(replay, fetchSnapshot)
    ).applyReattachPayload()

    expect(fetchSnapshot).not.toHaveBeenCalled()
    expect(session.rememberReattachPayloadAgentSignal).toHaveBeenCalledWith(replay, {
      fullScreenReplay: true
    })
  })

  it('uses relay when the snapshot frame width is incompatible', async () => {
    const fetchSnapshot = vi.fn(async () => createSnapshot())
    const session = createSession()
    session.pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 40 }))

    await createReattachPayloadHandlers(
      session,
      createContext('RELAY-TAIL', fetchSnapshot)
    ).applyReattachPayload()

    expect(fetchSnapshot).toHaveBeenCalledOnce()
    expect(session.rememberReattachPayloadAgentSignal).toHaveBeenCalledWith('RELAY-TAIL', {
      fullScreenReplay: true
    })
    expect(session.setRestoredSnapshotBaseline).not.toHaveBeenCalled()
  })

  it('layers outage kitty mode changes over the snapshot baseline', async () => {
    const session = createSession()
    const replay = `${KITTY_PUSH}REDRAW`

    await createReattachPayloadHandlers(
      session,
      createContext(replay, async () => createSnapshot({ kittyKeyboardFlags: 0, seq: 10 }))
    ).applyReattachPayload()

    expect(session.applySnapshotKittyKeyboardModes).toHaveBeenCalledWith('MODEL-FRAME', {
      kittyKeyboardFlags: 0,
      snapshotSeq: 10
    })
    expect(session.kittyKeyboardModes.scanReplay).toHaveBeenCalledWith(replay)
    expect(session.applySnapshotKittyKeyboardModes.mock.invocationCallOrder[0]).toBeLessThan(
      session.kittyKeyboardModes.scanReplay.mock.invocationCallOrder[0]
    )
  })
})
