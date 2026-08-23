import type { useAppStore } from '@/store'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { findIndexedRepoOwnerForHost } from '@/lib/worktree-runtime-owner-index'
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
  executionHostId: ExecutionHostId
  worktree: NonNullable<ReturnType<LaunchStore['getKnownWorktreeById']>> | null
  repo: LaunchRepo | null
}

/** Resolves folder launch ownership from workspace scope when no repo row exists. */
export function resolveAgentBackgroundLaunchHost(args: {
  store: LaunchStore
  worktreeId: string
  worktreePath?: string
  repo?: LaunchRepo | null
}): AgentBackgroundLaunchHost {
  const { store, worktreeId } = args
  const executionHostId = getResolvedExecutionHostIdForWorktree(store, worktreeId)
  if (!executionHostId) {
    throw new Error('The target workspace host is unavailable or ambiguous.')
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return {
      connectionId: null,
      platform: CLIENT_PLATFORM,
      isRemote: false,
      expectedConnectionId: null,
      executionHostId,
      worktree: null,
      repo: null
    }
  }
  const worktree = store.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const repo = findIndexedRepoOwnerForHost(store.repos, worktree.repoId, executionHostId)
  const worktreePath = worktree.path
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
      executionHostId
    }
  }
  const parsedHost = parseExecutionHostId(executionHostId)
  const folderWorkspaceConnectionId =
    parsedHost?.kind === 'ssh' ? parsedHost.targetId : parsedHost ? null : undefined
  const isFolderWorkspace = parseWorkspaceKey(worktreeId)?.type === 'folder'
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
    executionHostId
  }
}
