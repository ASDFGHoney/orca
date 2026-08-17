import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { resolveTabAgentFromSignals } from './use-tab-agent'

export type OpenTabOccupantAgentInput = {
  tabId: string
  /** Visible search/tab-strip label. Used only when the terminal record title is empty. */
  title?: string
  /** OSC title `useTabAgent` reads. */
  recordTitle?: string
  defaultTitle?: string
  launchAgent?: TuiAgent
  layout?: TerminalLayoutSnapshot
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  paneForegroundAgentByPaneKey?: Record<string, PaneForegroundAgentEntry>
}

/**
 * Search-row occupant: the tab-strip identity function, with the same
 * hook/sibling/sleeping/process inputs `useTabAgent` gathers. No second ladder.
 */
export function resolveOpenTabOccupantAgent({
  tabId,
  title,
  recordTitle,
  defaultTitle,
  launchAgent,
  layout,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey,
  paneForegroundAgentByPaneKey
}: OpenTabOccupantAgentInput): TuiAgent | null {
  const hookAgent = resolveFocusedTabAgent(agentStatusByPaneKey, layout, tabId)
  const siblingHookAgent = resolveSiblingTabAgent(agentStatusByPaneKey, layout, tabId)
  const focusedCompletedHookAgent =
    resolveFocusedCompletedTabAgent(agentStatusByPaneKey, layout, tabId) ??
    resolveFocusedRetainedTabAgent(retainedAgentsByPaneKey, layout, tabId)
  const siblingCompletedHookAgent =
    resolveSiblingCompletedTabAgent(agentStatusByPaneKey, layout, tabId) ??
    resolveSiblingRetainedTabAgent(retainedAgentsByPaneKey, layout, tabId)
  const focusedPaneKey = focusedPaneKeyFor(tabId, layout)
  const process = focusedPaneKey ? paneForegroundAgentByPaneKey?.[focusedPaneKey] : undefined
  const processAgent = process?.agent ?? null
  const sleepingSessionAgent = focusedPaneKey
    ? (sleepingAgentSessionsByPaneKey[focusedPaneKey]?.agent ?? null)
    : null
  const oscTitle = recordTitle?.trim() || title?.trim() || ''
  const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(oscTitle)
  const fallbackAgentSignal = launchAgent
    ? explicitTitleAgent === launchAgent
    : Boolean(explicitTitleAgent || siblingHookAgent)

  return resolveTabAgentFromSignals({
    hasObservedAgentSignal: Boolean(
      hookAgent || focusedCompletedHookAgent || processAgent || fallbackAgentSignal
    ),
    // Search does not observe OSC 133;D, so do not apply local-only exit clearing.
    isRemote: true,
    title: oscTitle,
    defaultTitle,
    hookAgent,
    siblingHookAgent,
    focusedCompletedHookAgent,
    siblingCompletedHookAgent,
    processAgent,
    processShellForeground: Boolean(process?.shellForeground),
    sleepingSessionAgent,
    launchAgent
  })
}

function focusedPaneKeyFor(
  tabId: string,
  layout: TerminalLayoutSnapshot | undefined
): string | null {
  const activeLeafId = layout?.activeLeafId
  return activeLeafId && isTerminalLeafId(activeLeafId) ? makePaneKey(tabId, activeLeafId) : null
}
