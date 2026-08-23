import { describe, expect, it } from 'vitest'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'

describe('AUTOMATIONS_TABLE_GRID_CLASS', () => {
  it('shares leftover width across text columns instead of capping Project', () => {
    expect(AUTOMATIONS_TABLE_GRID_CLASS).toContain('min-w-[58rem]')
    expect(AUTOMATIONS_TABLE_GRID_CLASS).toMatch(/minmax\(8rem,1\.2fr\).*minmax\(6\.5rem,0\.9fr\)/)
  })
})
