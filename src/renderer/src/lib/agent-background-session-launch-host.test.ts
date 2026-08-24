import { describe, expect, it } from 'vitest'
import { resolveAgentBackgroundLaunchHost } from './agent-background-session-launch-host'

function makeFolderHostState(args: {
  connectionId: string | null
  folderPath: string
  active?: boolean
}) {
  const hostId = args.connectionId ? `ssh:${args.connectionId}` : 'local'
  const worktree = {
    id: 'folder:folder-1',
    repoId: 'folder-workspace:group-1',
    path: args.folderPath,
    hostId
  }
  return {
    activeWorktreeId: args.active === false ? 'other' : worktree.id,
    activeWorkspaceExecutionHostId: args.active === false ? null : hostId,
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        folderPath: args.folderPath,
        connectionId: args.connectionId,
        executionHostId: hostId
      }
    ],
    projectGroups: [
      {
        id: 'group-1',
        parentGroupId: null,
        connectionId: args.connectionId,
        executionHostId: hostId
      }
    ],
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    getKnownWorktreeById: (id: string, requestedHost?: string) =>
      id === worktree.id && requestedHost === hostId ? worktree : undefined
  }
}

describe('resolveAgentBackgroundLaunchHost', () => {
  it('keeps an authoritative local folder owner local', () => {
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath: '/project' }) as never,
      worktreeId: 'folder:folder-1'
    })

    expect(host).toMatchObject({ connectionId: null, isRemote: false, executionHostId: 'local' })
  })

  it('fails closed when same-ID folder ownership has no active discriminator', () => {
    const local = makeFolderHostState({ connectionId: null, folderPath: '/local', active: false })
    local.folderWorkspaces.push({
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/remote',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    })

    expect(() =>
      resolveAgentBackgroundLaunchHost({
        store: local as never,
        worktreeId: 'folder:folder-1'
      })
    ).toThrow('unavailable or ambiguous')
  })

  it('uses Linux startup quoting for a local WSL folder', () => {
    const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath }) as never,
      worktreeId: 'folder:folder-1'
    })

    expect(host.platform).toBe('linux')
  })

  it('fails closed when a non-runtime worktree only has a mismatched repo owner', () => {
    const worktree = {
      id: 'repo-1::/remote',
      repoId: 'repo-1',
      hostId: 'ssh:ssh-a',
      path: '/remote'
    }
    const store = {
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      folderWorkspaces: [],
      projectGroups: [],
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: { 'repo-1': [worktree] },
      detectedWorktreesByRepo: {},
      getKnownWorktreeById: (id: string, hostId?: string) =>
        id === worktree.id && hostId === worktree.hostId ? worktree : undefined
    }

    expect(() =>
      resolveAgentBackgroundLaunchHost({ store: store as never, worktreeId: worktree.id })
    ).toThrow('folder workspace host is unavailable or ambiguous')
  })

  it('allows a unique repo fallback only for an explicitly runtime-owned worktree', () => {
    const worktree = {
      id: 'repo-1::/remote',
      repoId: 'repo-1',
      hostId: 'ssh:ssh-a',
      runtimeOwnerEnvironmentId: 'runtime-a',
      path: '/remote'
    }
    const store = {
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      folderWorkspaces: [],
      projectGroups: [],
      repos: [
        {
          id: 'repo-1',
          path: '/remote',
          connectionId: 'ssh-a',
          executionHostId: 'runtime:runtime-a'
        }
      ],
      worktreesByRepo: { 'repo-1': [worktree] },
      detectedWorktreesByRepo: {},
      getKnownWorktreeById: (id: string, hostId?: string) =>
        id === worktree.id && hostId === 'ssh:ssh-a' ? worktree : undefined
    }

    expect(
      resolveAgentBackgroundLaunchHost({ store: store as never, worktreeId: worktree.id })
    ).toMatchObject({ connectionId: 'ssh-a', executionHostId: 'ssh:ssh-a' })
  })
})
