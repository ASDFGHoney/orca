import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  collectClaimedPtyIds,
  deriveExitedPtyIdsFromListing,
  isLocalDaemonMintedPtyId,
  markPtySessionsExited,
  type PtySessionClaimMaps
} from './pty-session-liveness'

const LOCAL_PTY_A = 'repo1::/path/wt1@@aaaa'
const LOCAL_PTY_B = 'repo1::/path/wt1@@bbbb'
const LOCAL_PTY_C = 'repo1::/path/wt2@@cccc'

function makeTab(id: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: `wt-${id}`,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeLayout(ptyIdsByLeafId: Record<string, string>): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: 'leaf-1' },
    activeLeafId: 'leaf-1',
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function makeClaims(overrides: Partial<PtySessionClaimMaps> = {}): PtySessionClaimMaps {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

describe('collectClaimedPtyIds', () => {
  it('gathers ids from live attachments, tab wake hints, and layout leaf hints', () => {
    const claimed = collectClaimedPtyIds(
      makeClaims({
        tabsByWorktree: { 'wt-1': [makeTab('tab-1', LOCAL_PTY_A)] },
        ptyIdsByTabId: { 'tab-1': [LOCAL_PTY_B] },
        terminalLayoutsByTabId: { 'tab-1': makeLayout({ 'leaf-1': LOCAL_PTY_C }) }
      })
    )
    expect(claimed).toEqual(new Set([LOCAL_PTY_A, LOCAL_PTY_B, LOCAL_PTY_C]))
  })
})

describe('isLocalDaemonMintedPtyId', () => {
  it('accepts minted local session ids only', () => {
    expect(isLocalDaemonMintedPtyId(LOCAL_PTY_A)).toBe(true)
    expect(isLocalDaemonMintedPtyId('ssh:conn-1@@pty-3')).toBe(false)
    expect(isLocalDaemonMintedPtyId('remote:handle-7')).toBe(false)
    // Bare relay/uuid ids do not match the minted `${repoId}::${path}@@` shape.
    expect(isLocalDaemonMintedPtyId('pty-3')).toBe(false)
    expect(isLocalDaemonMintedPtyId('0b7c9a1e-4f3d-4c2a-9d7e-1234567890ab')).toBe(false)
    // SSH connection ids can themselves contain `::` (IPv6 targets); the
    // `ssh:` namespace must win over the minted-shape heuristic.
    expect(isLocalDaemonMintedPtyId('ssh:user@[::1]@@pty-1')).toBe(false)
  })
})

describe('deriveExitedPtyIdsFromListing', () => {
  it('reports minted claims the listing omits and spares live, foreign, and mid-flight ids', () => {
    const exited = deriveExitedPtyIdsFromListing({
      claimedBeforeRequest: new Set([
        LOCAL_PTY_A, // dead: minted, absent from listing
        LOCAL_PTY_B, // alive: listed
        'ssh:conn-1@@pty-3', // ssh: absence is not authoritative
        'remote:handle-7', // runtime: never listed
        LOCAL_PTY_C // woken mid-flight: attached now but not before
      ]),
      attachedBeforeRequest: new Set([LOCAL_PTY_A]),
      attachedNow: new Set([LOCAL_PTY_A, LOCAL_PTY_C]),
      listedSessionIds: new Set([LOCAL_PTY_B])
    })
    expect(exited).toEqual([LOCAL_PTY_A])
  })
})

describe('markPtySessionsExited', () => {
  const claims = makeClaims({
    tabsByWorktree: { 'wt-1': [makeTab('tab-1', LOCAL_PTY_A)] },
    ptyIdsByTabId: { 'tab-1': [LOCAL_PTY_B] }
  })

  it('records claimed ids and returns null when nothing changes', () => {
    const next = markPtySessionsExited({}, [LOCAL_PTY_A], claims)
    expect(next).toEqual({ [LOCAL_PTY_A]: true })
    expect(markPtySessionsExited(next!, [LOCAL_PTY_A], claims)).toBeNull()
  })

  it('ignores exits for ids no longer claimed anywhere', () => {
    expect(markPtySessionsExited({}, [LOCAL_PTY_C], claims)).toBeNull()
  })

  it('drops recorded ids once their claims disappear', () => {
    const current = { [LOCAL_PTY_A]: true, [LOCAL_PTY_C]: true } as Record<string, true>
    expect(markPtySessionsExited(current, [], claims)).toEqual({ [LOCAL_PTY_A]: true })
  })
})
