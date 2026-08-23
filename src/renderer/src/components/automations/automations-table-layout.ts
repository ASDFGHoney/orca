/** Column template for the automations list table; shared chrome lives in @/lib/list-table-layout. */
// Name | Schedule | Project | Host | Next run | Last run | Status | Agent | Actions
// fr maxes share leftover width; rem maxes dumped it into Name and truncated Project.
export const AUTOMATIONS_TABLE_GRID_CLASS =
  'grid w-full min-w-[58rem] grid-cols-[minmax(8rem,1.2fr)_minmax(7.5rem,0.95fr)_minmax(6.5rem,0.9fr)_minmax(5rem,0.7fr)_minmax(7rem,0.85fr)_minmax(6.5rem,0.8fr)_minmax(4.5rem,5.5rem)_2.5rem_2.5rem]'
