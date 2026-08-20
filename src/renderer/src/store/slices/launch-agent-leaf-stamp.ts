import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

/**
 * Bind tab-scoped launchAgent to the first sole leaf the layout describes.
 * Later topologies must not overwrite it — a remaining sibling after a close
 * is also a sole leaf, and inheriting would recycle the launched identity.
 */
export function stampLaunchAgentLeafIdOnFirstLayout(args: {
  tabs: readonly TerminalTab[]
  tabId: string
  previousLayout: TerminalLayoutSnapshot | undefined
  nextLayout: TerminalLayoutSnapshot
}): TerminalTab[] | null {
  if (args.previousLayout?.root) {
    return null
  }
  const nextRoot = args.nextLayout.root
  if (nextRoot?.type !== 'leaf' || !isTerminalLeafId(nextRoot.leafId)) {
    return null
  }
  const tabIndex = args.tabs.findIndex((tab) => tab.id === args.tabId)
  const tab = args.tabs[tabIndex]
  if (!tab?.launchAgent || tab.launchAgentLeafId) {
    return null
  }
  const nextTabs = [...args.tabs]
  nextTabs[tabIndex] = { ...tab, launchAgentLeafId: nextRoot.leafId }
  return nextTabs
}
