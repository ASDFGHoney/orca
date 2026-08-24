import type { useAppStore } from '@/store'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import {
  findIndexedWorktreeOwner,
  resolveIndexedWorktreeOwner,
  findIndexedRepoOwner,
  findIndexedRepoOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

type LaunchStore = ReturnType<typeof useAppStore.getState>
type LaunchRepo = LaunchStore['repos'][number]

export type AgentBackgroundLaunchHost = {
  /** SSH connection to spawn on, or null for a local launch. */
  connectionId: string | null
  /** Platform whose shell quoting and CLI naming the startup plan must target. */
  platform: NodeJS.Platform
  isRemote: boolean
  /** Accepted status connection; undefined preserves unknown-owner behavior. */
  expectedConnectionId: string | null | undefined
  /** Null only for legacy records whose host owner was not persisted. */
  executionHostId: ExecutionHostId | null
  worktree: NonNullable<ReturnType<LaunchStore['getKnownWorktreeById']>> | null
  repo: LaunchRepo | null
}

/** Resolves folder launch ownership from workspace scope when no repo row exists. */
export function resolveAgentBackgroundLaunchHost(args: {
  store: LaunchStore
  worktreeId: string
  worktreePath?: string
  repo?: LaunchRepo | null
  /** Legacy resume records predate persisted execution-host ownership. */
  allowLegacyUnknownHost?: boolean
}): AgentBackgroundLaunchHost {
  const { store, worktreeId, allowLegacyUnknownHost = false } = args
  const executionHostId = getResolvedExecutionHostIdForWorktree(store, worktreeId)
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const legacyWorktreeResolution =
    !executionHostId && workspaceScope?.type !== 'folder'
      ? resolveIndexedWorktreeOwner(store.worktreesByRepo, worktreeId)
      : null
  const legacyWorktree = executionHostId
    ? null
    : workspaceScope?.type === 'folder'
      ? (store.getKnownWorktreeById(worktreeId) ?? null)
      : (() => {
          const owner = findIndexedWorktreeOwner(store.worktreesByRepo, worktreeId)
          return owner ? (store.getKnownWorktreeById(worktreeId) ?? null) : null
        })()
  const legacyRepo =
    args.repo ??
    (legacyWorktree
      ? (() => {
          const owner = findIndexedRepoOwner(store.repos, legacyWorktree.repoId)
          return owner
            ? (store.repos.find(
                (entry) =>
                  entry.id === owner.id &&
                  entry.connectionId === owner.connectionId &&
                  entry.executionHostId === owner.executionHostId
              ) ?? null)
            : null
        })()
      : null)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : undefined
  const isFolderWorkspace = folderWorkspaceId !== undefined
  if (!executionHostId && !legacyWorktree && worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    if (legacyWorktreeResolution?.kind === 'ambiguous') {
      throw new Error('The target workspace host is unavailable or ambiguous.')
    }
    const ownershipCatalogHydrated =
      Object.keys(store.worktreesByRepo ?? {}).length > 0 ||
      store.repos.length > 0 ||
      store.folderWorkspaces.length > 0
    if (
      !allowLegacyUnknownHost ||
      ownershipCatalogHydrated ||
      (isFolderWorkspace && store.folderWorkspaces.some((entry) => entry.id === folderWorkspaceId))
    ) {
      throw new Error('The target workspace host is unavailable or ambiguous.')
    }
    return {
      connectionId: legacyRepo?.connectionId ?? null,
      platform: legacyRepo
        ? getAgentLaunchPlatformForRepo(
            legacyRepo,
            legacyRepo.connectionId
              ? undefined
              : getLocalProjectExecutionRuntimeContext(store, worktreeId)
          )
        : CLIENT_PLATFORM,
      isRemote: Boolean(legacyRepo?.connectionId),
      expectedConnectionId: legacyRepo?.connectionId ?? undefined,
      executionHostId: null,
      worktree: null,
      repo: legacyRepo
    }
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return {
      connectionId: null,
      platform: CLIENT_PLATFORM,
      isRemote: false,
      expectedConnectionId: null,
      executionHostId: executionHostId ?? null,
      worktree: null,
      repo: null
    }
  }
  const worktree =
    (executionHostId ? store.getKnownWorktreeById(worktreeId, executionHostId) : legacyWorktree) ??
    null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const parsedExecutionHost = parseExecutionHostId(executionHostId)
  const runtimeOwnedWorktree =
    parsedExecutionHost?.kind === 'runtime' &&
    worktree.runtimeOwnerEnvironmentId?.trim() === parsedExecutionHost.environmentId
  const runtimeRepoOwner = runtimeOwnedWorktree
    ? findIndexedRepoOwner(store.repos, worktree.repoId)
    : null
  const runtimeRepo = runtimeRepoOwner
    ? (store.repos.find(
        (entry) =>
          entry.id === runtimeRepoOwner.id &&
          entry.connectionId === runtimeRepoOwner.connectionId &&
          entry.executionHostId === runtimeRepoOwner.executionHostId
      ) ?? null)
    : null
  const repo = executionHostId
    ? (findIndexedRepoOwnerForHost(store.repos, worktree.repoId, executionHostId) ?? runtimeRepo)
    : legacyRepo
  const worktreePath = args.worktreePath ?? worktree.path
  if (repo) {
    return {
      connectionId: repo.connectionId ?? null,
      platform: getAgentLaunchPlatformForRepo(
        repo,
        repo.connectionId ? undefined : getLocalProjectExecutionRuntimeContext(store, worktreeId)
      ),
      isRemote: repoIsRemote(repo),
      expectedConnectionId: repo.connectionId ?? null,
      worktree,
      repo,
      executionHostId: executionHostId ?? null
    }
  }
  if (!executionHostId && allowLegacyUnknownHost) {
    return {
      connectionId: null,
      platform: CLIENT_PLATFORM,
      isRemote: false,
      expectedConnectionId: undefined,
      executionHostId: null,
      worktree,
      repo: null
    }
  }
  const folderWorkspaceConnectionId =
    parsedExecutionHost?.kind === 'ssh'
      ? parsedExecutionHost.targetId
      : parsedExecutionHost
        ? null
        : getFolderWorkspaceConnectionId(store, folderWorkspaceId ?? '')
  if (!isFolderWorkspace || folderWorkspaceConnectionId === undefined) {
    throw new Error('The target folder workspace host is unavailable or ambiguous.')
  }
  return {
    connectionId: folderWorkspaceConnectionId ?? null,
    platform: folderWorkspaceConnectionId
      ? isWindowsAbsolutePathLike(worktreePath ?? '')
        ? 'win32'
        : 'linux'
      : isWslUncPath(worktreePath ?? '')
        ? 'linux'
        : CLIENT_PLATFORM,
    isRemote: Boolean(folderWorkspaceConnectionId),
    expectedConnectionId: folderWorkspaceConnectionId ?? null,
    worktree,
    repo: null,
    executionHostId: executionHostId ?? null
  }
}
