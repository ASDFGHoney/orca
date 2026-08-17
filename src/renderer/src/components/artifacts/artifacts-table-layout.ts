/** Shared layout classes for the artifacts list table. Matches Automations / Tasks list tables. */
// Name | Type | Size | Updated | Expires | Actions
export const ARTIFACTS_TABLE_GRID_CLASS =
  'grid grid-cols-[minmax(0,1.6fr)_minmax(4.5rem,6.5rem)_minmax(4rem,5.5rem)_minmax(6.5rem,9rem)_minmax(6.5rem,9rem)_2.5rem]'

export const ARTIFACTS_TABLE_CONTAINER_CLASS = 'rounded-md border border-border/50 bg-muted/20'

export const ARTIFACTS_TABLE_HEADER_CLASS =
  'sticky top-0 z-10 h-8 items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground'

export const ARTIFACTS_TABLE_ROW_CLASS =
  'w-full min-h-11 cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export const ARTIFACTS_TABLE_ROW_SELECTED_CLASS = 'bg-accent text-accent-foreground'
