// Corruption never deletes history. A journal that cannot be read end to end
// keeps its intact prefix live and moves the unreadable remainder aside, so the
// bytes stay on disk for inspection instead of being rebuilt into an empty epoch.

import {
  quarantineJournalRemainder,
  readJournalLog,
  readJournalSnapshotFile,
  rewriteJournalLog
} from './journal-log-file'
import type { JournalRow } from './journal-row-schema'

/** Keep the readable prefix and set the unreadable suffix aside. */
export async function quarantineCorruptSuffix(
  journalDir: string,
  retainedRows: readonly JournalRow[],
  remainder: string | undefined
): Promise<void> {
  if (remainder) {
    await quarantineJournalRemainder(journalDir, remainder)
  }
  await rewriteJournalLog(journalDir, retainedRows)
}

/** Copy everything aside before a read-only journal is rebuilt under a newer
 *  schema: those rows are unreadable to THIS build, not worthless. */
export async function quarantineUnreadableSchema(journalDir: string): Promise<void> {
  const snapshot = await readJournalSnapshotFile(journalDir)
  const log = await readJournalLog(journalDir)
  const preserved = [
    snapshot ? JSON.stringify(snapshot) : '',
    log.rows.map((row) => JSON.stringify(row)).join('\n'),
    log.remainder ?? ''
  ]
    .filter(Boolean)
    .join('\n')
  if (preserved) {
    await quarantineJournalRemainder(journalDir, preserved)
  }
}
