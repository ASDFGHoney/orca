import React from 'react'
import { cn } from '@/lib/utils'
import {
  resolveAutomationListEmptyState,
  type AutomationListEmptyStateInput
} from './automation-list-empty-state'
import { AutomationHostRecoverButton } from './AutomationHostRecoverButton'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'

/** Renders whichever empty/partial/failure state the list is in; nothing when rows exist. */

export type AutomationListEmptyViewProps = AutomationListEmptyStateInput & {
  onRecover?: (action: AutomationHostRecoveryAction) => void | Promise<void>
  className?: string
}

export function AutomationListEmptyView({
  onRecover,
  className,
  ...input
}: AutomationListEmptyViewProps): React.JSX.Element | null {
  const state = resolveAutomationListEmptyState(input)
  const recovery = state.recovery
  if (state.kind === 'rows') {
    return null
  }

  return (
    <div
      data-empty-state={state.kind}
      className={cn(
        'flex flex-col items-center gap-1.5 px-6 py-10 text-center text-muted-foreground',
        className
      )}
    >
      <p className="text-sm text-foreground">{state.title}</p>
      {state.detail ? <p className="text-xs">{state.detail}</p> : null}
      {state.scopeNote ? (
        <p className="text-[11px]" data-scope-note="external-managers">
          {state.scopeNote}
        </p>
      ) : null}
      {recovery && onRecover ? (
        <AutomationHostRecoverButton
          action={recovery}
          onRecover={onRecover}
          size="sm"
          className="mt-1.5"
        />
      ) : null}
    </div>
  )
}
