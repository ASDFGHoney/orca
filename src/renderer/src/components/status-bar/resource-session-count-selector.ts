import type { AppState } from '../../store'
import {
  buildResourceSessionBindingIndex,
  type ResourceSessionBindingIndex,
  type ResourceSessionBindingInputs
} from './resource-session-bindings'

export type ClosedResourceSessionCountState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'workspaceSessionReady'
  | 'deadPtyIds'
>

type BuildResourceSessionBindingIndex = (
  inputs: ResourceSessionBindingInputs
) => ResourceSessionBindingIndex

export type ClosedResourceSessionCountSelector = (state: ClosedResourceSessionCountState) => number

function haveSameTabBindings(
  previous: AppState['tabsByWorktree'],
  next: AppState['tabsByWorktree']
): boolean {
  if (previous === next) {
    return true
  }

  const previousWorktreeIds = Object.keys(previous)
  const nextWorktreeIds = Object.keys(next)
  if (previousWorktreeIds.length !== nextWorktreeIds.length) {
    return false
  }

  for (const worktreeId of nextWorktreeIds) {
    const previousTabs = previous[worktreeId]
    const nextTabs = next[worktreeId]
    if (previousTabs === nextTabs) {
      continue
    }
    if (!previousTabs || previousTabs.length !== nextTabs.length) {
      return false
    }
    for (let index = 0; index < nextTabs.length; index += 1) {
      const previousTab = previousTabs[index]
      const nextTab = nextTabs[index]
      // Why: the closed badge counts PTY ownership only. Titles and other
      // display fields can churn per terminal frame without changing it.
      if (previousTab.id !== nextTab.id || previousTab.ptyId !== nextTab.ptyId) {
        return false
      }
    }
  }

  return true
}

// Why: bound wake hints can reference sessions that already exited (they are
// kept for cold-restore/wake). The badge counts RUNNING sessions, so proven
// dead ids are subtracted rather than counted (#8372).
function countRunningBoundPtyIds(
  boundPtyIds: ReadonlySet<string>,
  deadPtyIds: AppState['deadPtyIds']
): number {
  let dead = 0
  for (const ptyId of Object.keys(deadPtyIds)) {
    if (boundPtyIds.has(ptyId)) {
      dead += 1
    }
  }
  return boundPtyIds.size - dead
}

export function createClosedResourceSessionCountSelector(
  buildBindingIndex: BuildResourceSessionBindingIndex = buildResourceSessionBindingIndex
): ClosedResourceSessionCountSelector {
  // Why: Zustand runs selectors for every store notification. Keep the last
  // liveness inputs here so unrelated and title-only writes stay scalar-cheap.
  let initialized = false
  let previousTabsByWorktree: AppState['tabsByWorktree'] = {}
  let previousPtyIdsByTabId: AppState['ptyIdsByTabId'] = {}
  let previousTerminalLayoutsByTabId: AppState['terminalLayoutsByTabId'] = {}
  let previousWorkspaceSessionReady = false
  let previousDeadPtyIds: AppState['deadPtyIds'] = {}
  let boundPtyIds: ReadonlySet<string> = new Set()
  let count = 0

  return (state): number => {
    const bindingMapChanged =
      state.ptyIdsByTabId !== previousPtyIdsByTabId ||
      state.terminalLayoutsByTabId !== previousTerminalLayoutsByTabId
    const readinessChanged = state.workspaceSessionReady !== previousWorkspaceSessionReady
    const tabsReferenceChanged = state.tabsByWorktree !== previousTabsByWorktree
    let tabBindingsChanged = tabsReferenceChanged
    if (
      initialized &&
      state.workspaceSessionReady &&
      !bindingMapChanged &&
      !readinessChanged &&
      tabsReferenceChanged
    ) {
      tabBindingsChanged = !haveSameTabBindings(previousTabsByWorktree, state.tabsByWorktree)
    }

    const shouldRebuild =
      state.workspaceSessionReady &&
      (!initialized || bindingMapChanged || readinessChanged || tabBindingsChanged)
    const deadPtyIdsChanged = state.deadPtyIds !== previousDeadPtyIds

    if (shouldRebuild) {
      boundPtyIds = buildBindingIndex(state).boundPtyIds
      count = countRunningBoundPtyIds(boundPtyIds, state.deadPtyIds)
    } else if (!state.workspaceSessionReady) {
      boundPtyIds = new Set()
      count = 0
    } else if (deadPtyIdsChanged) {
      count = countRunningBoundPtyIds(boundPtyIds, state.deadPtyIds)
    }

    previousTabsByWorktree = state.tabsByWorktree
    previousPtyIdsByTabId = state.ptyIdsByTabId
    previousTerminalLayoutsByTabId = state.terminalLayoutsByTabId
    previousWorkspaceSessionReady = state.workspaceSessionReady
    previousDeadPtyIds = state.deadPtyIds
    initialized = true
    return count
  }
}
