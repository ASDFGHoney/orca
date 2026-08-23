import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../../../shared/task-source-context'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  automationCreateSetupMatchesDestination,
  type AutomationCreateDestination
} from './automation-create-destination'

export function buildAutomationRunContextForRepo(args: {
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
}): WorkspaceRunContext | null {
  const setup = args.projectHostSetups.find(
    (candidate) => candidate.repoId === args.repoId && candidate.setupState === 'ready'
  )
  if (!setup) {
    return null
  }
  const repo = args.repos.find((candidate) => candidate.id === setup.repoId)
  if (!repo) {
    return null
  }
  return buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path || repo.path
  })
}

export function buildAutomationRunContextForDestination(args: {
  repoId: string
  destination: AutomationCreateDestination
  projectHostSetups: readonly ProjectHostSetup[]
  worktree?: Worktree | null
}): WorkspaceRunContext | null {
  const candidates = args.projectHostSetups.filter(
    (candidate) =>
      candidate.repoId === args.repoId &&
      candidate.setupState === 'ready' &&
      automationCreateSetupMatchesDestination(candidate, args.destination)
  )
  const setup = args.worktree?.projectHostSetupId
    ? candidates.find((candidate) => candidate.id === args.worktree?.projectHostSetupId)
    : candidates[0]
  if (!setup) {
    return null
  }
  return buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path
  })
}
