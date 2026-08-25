import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import type { AppState } from '@/store/types'
import type { CloseTerminalDialogCopyKind } from '../terminal-pane/CloseTerminalDialog'
import { collectTabPtyIds, RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'
import { resolveBusyPtyCloseCopyKind } from './terminal-close-copy-kind'

/** A terminal tab in the bulk set, with the PTYs it could still own. */
type BulkCloseCandidate = { terminalTabId: string; ptyIds: string[] }

/**
 * Terminal tab ids (entity ids) inside a mixed tab-strip id list, skipping the pinned tabs
 * a bulk close leaves alone. Accepts either unified-tab ids or entity ids because the tab
 * strip emits entity ids for terminals and unified ids for editors.
 */
export function collectBulkTerminalTabIds(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'tabsByWorktree'>,
  worktreeId: string,
  visibleIds: readonly string[]
): string[] {
  const unifiedTabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const terminalTabIds: string[] = []
  for (const visibleId of visibleIds) {
    const unifiedTab = unifiedTabs.find(
      (candidate) => candidate.id === visibleId || candidate.entityId === visibleId
    )
    if (unifiedTab) {
      if (unifiedTab.contentType === 'terminal' && unifiedTab.isPinned !== true) {
        terminalTabIds.push(unifiedTab.entityId)
      }
      continue
    }
    // Why: agent quick-launch can briefly leave a terminal in the runtime store before its
    // unified row lands; missing it here would silently drop the prompt for a busy tab.
    if ((state.tabsByWorktree?.[worktreeId] ?? []).some((tab) => tab.id === visibleId)) {
      terminalTabIds.push(visibleId)
    }
  }
  return terminalTabIds
}

/** Stable dedupe key so a double-fired bulk close merges into one prompt. A lone busy tab
 *  keys on its real id, so it also merges with that tab's own single-close prompt. */
function resolveRequestKey(busyTabIds: readonly string[]): string {
  return busyTabIds.length === 1 ? busyTabIds[0]! : `bulk:${[...busyTabIds].sort().join(',')}`
}

/**
 * Routes "Close Others" / "Close Tabs To The Right" / "Close Tabs To The Left" through one
 * aggregated running-process confirmation instead of the modal storm that made these paths
 * opt out of the prompt entirely. Proceeds synchronously when no tab in the set has a live
 * PTY, so idle bulk closes keep today's behavior.
 *
 * Cancel abandons the whole bulk close rather than closing the idle subset: a partial,
 * un-undoable close is a worse surprise than doing nothing and letting the user retry.
 */
export function guardBulkTerminalClose(params: {
  worktreeId: string
  terminalTabIds: readonly string[]
  onProceed: () => void
  onCancel?: () => void
}): void {
  const { worktreeId, terminalTabIds, onProceed, onCancel } = params
  const state = useAppStore.getState()
  const settings = state.settings
  const candidates: BulkCloseCandidate[] = []
  for (const terminalTabId of new Set(terminalTabIds)) {
    const ptyIds = collectTabPtyIds(state, terminalTabId)
    if (ptyIds.length > 0) {
      candidates.push({ terminalTabId, ptyIds })
    }
  }
  // Why: nothing to probe (parked/hibernated tabs, or a set with no terminals at all) and
  // the opt-out setting both mean the answer is known, so the close stays synchronous.
  if (candidates.length === 0 || settings?.skipCloseTerminalWithRunningProcessConfirm === true) {
    onProceed()
    return
  }

  // Why: the timeout, the probe result and the error path race to decide this close, so the
  // first one to land owns it instead of trusting those races to stay mutually exclusive.
  let decided = false
  const proceedNow = (): void => {
    if (decided) {
      return
    }
    decided = true
    onProceed()
  }
  const confirmClose = (busy: readonly BulkCloseCandidate[]): void => {
    if (decided) {
      return
    }
    const latest = useAppStore.getState()
    const busyTabLabels = busy.map((candidate) =>
      resolvePinnedTabLabel(latest, worktreeId, candidate.terminalTabId)
    )
    // Why: an agent anywhere in the set wins the wording, matching the single-tab prompt's
    // mixed-split rule — stopping an agent mid-task is the costlier surprise.
    const copyKind: CloseTerminalDialogCopyKind = busy.some(
      (candidate) =>
        resolveBusyPtyCloseCopyKind(candidate.terminalTabId, candidate.ptyIds) === 'agent'
    )
      ? 'agent'
      : 'command'
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId: resolveRequestKey(busy.map((candidate) => candidate.terminalTabId)),
      tabLabel: busyTabLabels[0] ?? '',
      busyTabLabels,
      copyKind,
      onConfirm: onProceed,
      ...(onCancel ? { onCancel } : {})
    })
    // Why: only once the prompt is actually up — if either call above throws, the close must
    // still be free to fall through and happen.
    decided = true
  }

  const probes = candidates.flatMap((candidate) =>
    candidate.ptyIds.map((ptyId) => ({ candidate, ptyId }))
  )
  const probeTimeout = setTimeout(() => {
    try {
      // Why: a probe that has not answered yet is unknown, not idle. Ask about every
      // candidate so a degraded relay costs a click instead of killed remote work.
      confirmClose(candidates)
    } catch {
      proceedNow()
    }
  }, RUNNING_CLOSE_PROBE_TIMEOUT_MS)

  void Promise.allSettled(probes.map(({ ptyId }) => inspectRuntimeTerminalProcess(settings, ptyId)))
    .then((results) => {
      clearTimeout(probeTimeout)
      if (decided) {
        return
      }
      // Why: fail open on an *answered* probe, matching the single-tab guard — a rejection
      // or a stale remote handle is not evidence of a live child, and a menu action that
      // silently does nothing is worse than closing a busy tab.
      const busyPtyIdsByTabId = new Map<string, string[]>()
      results.forEach((result, index) => {
        if (
          result.status !== 'fulfilled' ||
          !result.value.hasChildProcesses ||
          result.value.unavailable === true
        ) {
          return
        }
        const probe = probes[index]!
        const busyPtyIds = busyPtyIdsByTabId.get(probe.candidate.terminalTabId)
        if (busyPtyIds) {
          busyPtyIds.push(probe.ptyId)
        } else {
          busyPtyIdsByTabId.set(probe.candidate.terminalTabId, [probe.ptyId])
        }
      })
      if (busyPtyIdsByTabId.size === 0) {
        proceedNow()
        return
      }
      // Why: walk `candidates` rather than the map so the prompt lists tabs in strip order.
      confirmClose(
        candidates
          .filter((candidate) => busyPtyIdsByTabId.has(candidate.terminalTabId))
          .map((candidate) => ({
            terminalTabId: candidate.terminalTabId,
            ptyIds: busyPtyIdsByTabId.get(candidate.terminalTabId)!
          }))
      )
    })
    // Why: allSettled never rejects, so this only fires when the decision above throws (a
    // label lookup, a store subscriber). Without it the bulk close would silently never
    // happen and the user would get no feedback at all.
    .catch(() => {
      clearTimeout(probeTimeout)
      proceedNow()
    })
}
