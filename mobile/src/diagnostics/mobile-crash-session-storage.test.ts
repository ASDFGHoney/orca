import { describe, expect, it } from 'vitest'
import type { CrashReportBreadcrumb } from '../../../src/shared/crash-reporting'
import {
  MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS,
  parseMobileCrashJournal,
  serializeMobileCrashJournal,
  type PersistedMobileCrashJournal
} from './mobile-crash-session-storage'

const OPENED_AT = '2026-08-24T18:00:00.000Z'

function makeLargeBreadcrumbs(prefix: string, count: number): CrashReportBreadcrumb[] {
  return Array.from({ length: count }, (_, index) => ({
    createdAt: OPENED_AT,
    name: 'render_error_contained',
    data: { errorStack: `${prefix}-${index}-${'x'.repeat(3_900)}` }
  }))
}

function makeJournal(
  activeBreadcrumbs: CrashReportBreadcrumb[],
  previousBreadcrumbs?: CrashReportBreadcrumb[]
): PersistedMobileCrashJournal {
  return {
    version: 1,
    activeSession: {
      id: 'active-session',
      openedAt: OPENED_AT,
      marker: 'open',
      breadcrumbs: activeBreadcrumbs
    },
    ...(previousBreadcrumbs
      ? { latestAbnormalSession: { openedAt: OPENED_AT, breadcrumbs: previousBreadcrumbs } }
      : {})
  }
}

describe('mobile crash session storage', () => {
  it('caps a journal whose breadcrumb ring exceeds the payload budget', () => {
    const serialized = serializeMobileCrashJournal(makeJournal(makeLargeBreadcrumbs('active', 30)))

    expect(serialized.length).toBeLessThanOrEqual(MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS)
  })

  it('evicts current breadcrumbs before previous abnormal-session evidence', () => {
    const serialized = serializeMobileCrashJournal(
      makeJournal(makeLargeBreadcrumbs('active', 12), makeLargeBreadcrumbs('previous', 12))
    )
    const parsed = parseMobileCrashJournal(serialized)

    expect(parsed?.latestAbnormalSession?.breadcrumbs.length).toBeGreaterThan(
      parsed?.activeSession.breadcrumbs.length ?? 0
    )
  })
})
