import type { DatabaseSync } from 'node:sqlite'
import type { ImportedDomainScope } from './browser-cookie-import-policy'
import {
  domainIsInImportedScope,
  isNonTransplantableCookieDomain,
  normalizeCookieDomain
} from './browser-cookie-import-policy'

type StagedHostKeyRow = { host_key: string }

// Why (STA-4797): the staged image is a copy of the live jar that replaces it wholesale on the next
// cold start, so whatever it deletes, the user loses — one restart later than the live clear, which
// is why an empty-jar fixture never sees it. It clears to the same scope as the live clear, through
// the same predicate, so the two cannot drift apart.
//
// A raw Chromium host_key carries no host-only column: a domain cookie is stored with a leading dot
// and a host-only cookie without one, which is the same distinction Cookie.hostOnly makes.
export function deleteStagedCookiesInImportScope(
  stagingDb: DatabaseSync,
  importScope: ImportedDomainScope
): void {
  if (importScope.exact.size === 0) {
    return
  }
  const hostKeys = (
    stagingDb.prepare('SELECT DISTINCT host_key FROM cookies').all() as StagedHostKeyRow[]
  ).map((row) => row.host_key)
  const deleteByHostKey = stagingDb.prepare('DELETE FROM cookies WHERE host_key = ?')
  for (const hostKey of hostKeys) {
    if (typeof hostKey !== 'string' || isNonTransplantableCookieDomain(hostKey)) {
      continue
    }
    const domain = normalizeCookieDomain(hostKey)
    if (!domain || !domainIsInImportedScope(importScope, domain, !hostKey.startsWith('.'))) {
      continue
    }
    deleteByHostKey.run(hostKey)
  }
}
