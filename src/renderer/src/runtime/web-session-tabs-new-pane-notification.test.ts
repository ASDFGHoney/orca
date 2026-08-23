// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getUnreadBadgeCount } from '@/lib/unread-badge-count'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey
}))
vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return { ...actual, getExplicitRuntimeEnvironmentIdForWorktree: () => null }
})

import { resetAgentCompletionCoordinatorIdentitiesForTest } from '@/components/terminal-pane/agent-completion-coordinator'
import { resetAgentHookCompletionNotificationCoordinators } from '@/hooks/agent-hook-completion-notifications'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

const ENVIRONMENT_ID = 'env-new-pane'
const RUNTIME_ID = 'runtime-new-pane'
const REVISION = 101
const REPO_ID = 'repo-new-pane'
const WORKTREE_ID = `${REPO_ID}::/worktree`
const OTHER_WORKTREE_ID = `${REPO_ID}::/other`
const NEW_WORKTREE_ID = `${REPO_ID}::/new-worktree`
const HOST_TAB_ID = 'host-tab-new-pane'
const NEW_HOST_TAB_ID = 'host-tab-new-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const NOW = 1_700_000_000_000
const MIRROR_KEY = `${ENVIRONMENT_ID}\u0001${RUNTIME_ID}\u00011\u0001${REVISION}`
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}

const subscriptions: RuntimeSubscription[] = []
const notificationDispatch = vi.fn(async () => ({ delivered: true as const }))
const runtimeCall = vi.fn(
  async (): Promise<RuntimeRpcResponse<unknown>> => ({
    id: 'list-all',
    ok: true,
    result: { snapshots: [] },
    _meta: { runtimeId: RUNTIME_ID }
  })
)
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})

function snapshot(
  snapshotVersion: number,
  state?: 'working' | 'done' | 'blocked',
  identity: { worktree?: string; hostTabId?: string; leafId?: string } = {}
): RuntimeMobileSessionTabsResult {
  const worktree = identity.worktree ?? WORKTREE_ID
  const hostTabId = identity.hostTabId ?? HOST_TAB_ID
  const leafId = identity.leafId ?? LEAF_ID
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: state ? 'host-group-1' : null,
    activeTabId: state ? hostTabId : null,
    activeTabType: state ? 'terminal' : null,
    tabs: state
      ? [
          {
            type: 'terminal',
            id: `${hostTabId}::${leafId}`,
            title: 'Claude',
            parentTabId: hostTabId,
            leafId,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-new-pane',
            agentStatus: {
              state,
              prompt: 'finish while hidden',
              updatedAt: NOW + snapshotVersion,
              stateStartedAt: NOW + snapshotVersion,
              agentType: 'claude',
              paneKey: makePaneKey(hostTabId, leafId),
              tabId: hostTabId,
              worktreeId: worktree,
              stateHistory: []
            }
          }
        ]
      : []
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function globalSubscription(occurrence = 0): RuntimeSubscription {
  const subscription = subscriptions.filter(
    ({ request }) => request.method === 'session.tabs.subscribeAll'
  )[occurrence]
  if (!subscription) {
    throw new Error(`Missing global subscription ${occurrence}`)
  }
  return subscription
}

async function publish(subscription: RuntimeSubscription, result: unknown): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'subscription-event',
      ok: true,
      result,
      _meta: { runtimeId: RUNTIME_ID }
    })
    await settle()
  })
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function parkAndReveal(): Promise<void> {
  act(() => {
    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
  })
  await act(settle)
}

describe('remote new-pane notification evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    notificationDispatch.mockClear()
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, value) => value)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetAgentHookCompletionNotificationCoordinators()
    resetWebSessionTabsSnapshotFreshnessForTests()
    const runtimeEnvironments = [
      { id: ENVIRONMENT_ID, createdAt: 100, pairingRevision: REVISION }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: OTHER_WORKTREE_ID,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: new Map([
          [ENVIRONMENT_ID, { status: { runtimeId: RUNTIME_ID }, connectionGeneration: 1 }]
        ]) as AppState['runtimeStatusByEnvironmentId'],
        worktreesByRepo: {
          [REPO_ID]: [
            makeWorktree({
              id: WORKTREE_ID,
              repoId: REPO_ID,
              runtimeOwnerEnvironmentId: ENVIRONMENT_ID
            }),
            makeWorktree({ id: OTHER_WORKTREE_ID, repoId: REPO_ID })
          ]
        }
      },
      true
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe },
        notifications: { dispatch: notificationDispatch }
      }
    })
    setDocumentVisibility('visible')
  })

  afterEach(() => {
    cleanup()
    resetAgentHookCompletionNotificationCoordinators()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetWebSessionTabsSnapshotFreshnessForTests()
    replaceRuntimeEnvironmentRevisions([])
    useAppStore.setState(initialState, true)
    setDocumentVisibility('visible')
    vi.useRealTimers()
  })

  it.each(['done', 'blocked'] as const)(
    'alerts before store hydration when a new hidden pane first appears as %s',
    async (state) => {
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await publish(globalSubscription(), { type: 'updated', ...snapshot(1) })

      let finishRecovery = (_value: RuntimeMobileSessionTabsResult): void => {}
      mocks.recoverSnapshot.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRecovery = resolve
          })
      )
      notificationDispatch.mockClear()
      await parkAndReveal()
      await publish(globalSubscription(1), {
        type: 'snapshots',
        snapshots: [snapshot(2, state)]
      })

      expect(notificationDispatch).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toBeUndefined()
      expect(useAppStore.getState().worktreesByRepo[REPO_ID][0]?.isUnread).toBe(true)
      expect(getUnreadBadgeCount(useAppStore.getState())).toBe(1)

      finishRecovery(snapshot(2, state))
      await act(settle)
      hook.unmount()
    }
  )

  it('alerts for a new worktree first published during a warm resume', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(globalSubscription(), {
      type: 'snapshots',
      snapshots: [snapshot(1, 'working')]
    })
    useAppStore.setState((state) => ({
      worktreesByRepo: {
        ...state.worktreesByRepo,
        [REPO_ID]: [
          ...state.worktreesByRepo[REPO_ID],
          makeWorktree({
            id: NEW_WORKTREE_ID,
            repoId: REPO_ID,
            runtimeOwnerEnvironmentId: ENVIRONMENT_ID
          })
        ]
      }
    }))
    notificationDispatch.mockClear()

    await parkAndReveal()
    await publish(globalSubscription(1), {
      type: 'snapshots',
      snapshots: [
        snapshot(1, 'working'),
        snapshot(1, 'blocked', {
          worktree: NEW_WORKTREE_ID,
          hostTabId: NEW_HOST_TAB_ID,
          leafId: NEW_LEAF_ID
        })
      ]
    })

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(notificationDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ attentionRequired: true, worktreeId: NEW_WORKTREE_ID })
    )
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(1)
    hook.unmount()
  })

  it('ignores advancing remote floating-workspace agent state', async () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        experimentalTerminalAttention: true
      } as AppState['settings']
    })
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const identity = { worktree: FLOATING_TERMINAL_WORKTREE_ID }

    await publish(globalSubscription(), {
      type: 'updated',
      ...snapshot(1, 'working', identity)
    })
    notificationDispatch.mockClear()
    await publish(globalSubscription(), {
      type: 'updated',
      ...snapshot(2, 'done', identity)
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(0)
    hook.unmount()
  })

  it('drops a host transition for a viewer-locally closed committed pane', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(globalSubscription(), { type: 'updated', ...snapshot(1, 'working') })
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)

    useAppStore.setState((state) => ({
      tabsByWorktree: { ...state.tabsByWorktree, [WORKTREE_ID]: [] },
      unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    }))
    notificationDispatch.mockClear()
    await publish(globalSubscription(), { type: 'updated', ...snapshot(2, 'done') })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(0)
    hook.unmount()
  })
})
