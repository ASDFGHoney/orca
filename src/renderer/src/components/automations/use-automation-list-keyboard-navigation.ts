import React from 'react'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import {
  getAutomationListArrowNavigationTarget,
  type AutomationListArrowKey
} from './automation-list-keyboard-navigation'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationPaneTab } from './automation-page-state'

type KeyboardNavigationInput = {
  filteredRows: readonly AutomationListRow[]
  filteredExternalAutomationEntries: readonly ExternalAutomationListEntry[]
  selectedRowKey: string | null
  selectedExternalKey: string | null
  selectAutomationRow: (rowKey: string | null) => void
  selectExternalKey: (externalKey: string | null) => void
  setActivePaneTab: (tab: AutomationPaneTab) => void
  listRef: React.RefObject<HTMLDivElement | null>
}

export function useAutomationListKeyboardNavigation({
  filteredRows,
  filteredExternalAutomationEntries,
  selectedRowKey,
  selectedExternalKey,
  selectAutomationRow,
  selectExternalKey,
  setActivePaneTab,
  listRef
}: KeyboardNavigationInput): (key: AutomationListArrowKey) => void {
  const pendingScrollRef = React.useRef(false)
  const visibleItems = React.useMemo(
    () => [
      ...filteredRows.map((row) => ({ kind: 'local' as const, id: row.key })),
      ...filteredExternalAutomationEntries.map((entry) => ({
        kind: 'external' as const,
        id: entry.key
      }))
    ],
    [filteredExternalAutomationEntries, filteredRows]
  )
  const scrollCurrentIntoView = React.useCallback(() => {
    listRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [listRef])

  React.useEffect(() => {
    if (!pendingScrollRef.current) {
      return
    }
    pendingScrollRef.current = false
    scrollCurrentIntoView()
  }, [scrollCurrentIntoView, selectedExternalKey, selectedRowKey])

  return React.useCallback(
    (key) => {
      const next = getAutomationListArrowNavigationTarget({
        items: visibleItems,
        selectedId: selectedRowKey,
        selectedExternalKey,
        key
      })
      if (!next) {
        return
      }
      const selected =
        next.kind === 'local'
          ? selectedExternalKey === null && selectedRowKey === next.id
          : selectedExternalKey === next.id
      if (selected) {
        scrollCurrentIntoView()
        return
      }
      pendingScrollRef.current = true
      if (next.kind === 'local') {
        selectExternalKey(null)
        selectAutomationRow(next.id)
        return
      }
      selectAutomationRow(null)
      selectExternalKey(next.id)
      setActivePaneTab('overview')
    },
    [
      scrollCurrentIntoView,
      selectAutomationRow,
      selectExternalKey,
      selectedExternalKey,
      selectedRowKey,
      setActivePaneTab,
      visibleItems
    ]
  )
}
