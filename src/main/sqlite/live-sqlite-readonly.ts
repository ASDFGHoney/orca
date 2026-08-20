import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from './sync-database'

// Why: a live agent writer can hold an exclusive lock for the whole process.
// Waiting on busy_timeout just stalls the scan; snapshot the files instead.
const SNAPSHOT_IDLE_MS = 15_000
const SQLITE_BUSY_PATTERN =
  /database is locked|database is busy|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|EPERM|EBUSY/i

export const LIVE_SQLITE_UNAVAILABLE_MESSAGE =
  'Session history is temporarily unavailable. It will refresh on the next scan.'

export class LiveSqliteUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(LIVE_SQLITE_UNAVAILABLE_MESSAGE)
    this.name = 'LiveSqliteUnavailableError'
    if (cause instanceof Error) {
      this.cause = cause
    }
  }
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return SQLITE_BUSY_PATTERN.test(message)
}

export function isLiveSqliteUnavailableError(error: unknown): boolean {
  if (error instanceof LiveSqliteUnavailableError) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /temporarily unavailable/i.test(message) || isSqliteBusyError(error)
}

type LiveSqliteFileCopy = (source: string, dest: string) => void

let copyLiveSqliteFile: LiveSqliteFileCopy = copyFileSync

export function setLiveSqliteFileCopyForTests(copy: LiveSqliteFileCopy | null): void {
  copyLiveSqliteFile = copy ?? copyFileSync
}

type SnapshotLease = {
  dir: string
  dbFile: string
  refs: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

const snapshotLeases = new Map<string, SnapshotLease>()

class SnapshotReadonlyDatabase extends SyncDatabase {
  constructor(
    snapshotDbPath: string,
    private readonly releaseSnapshot: () => void
  ) {
    super(snapshotDbPath, { readonly: true, fileMustExist: true, timeout: 0 })
  }

  close(): void {
    try {
      super.close()
    } finally {
      this.releaseSnapshot()
    }
  }
}

function configureQueryOnly(db: SyncDatabase): SyncDatabase {
  try {
    db.pragma('query_only = ON')
    // Open itself can succeed while the first real read still takes SHARED and
    // throws SQLITE_BUSY, so probe before handing the handle to callers.
    db.prepare('SELECT 1 AS ok FROM sqlite_master LIMIT 1').get()
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // Preserve the open/probe failure.
    }
    throw error
  }
}

function copyLiveSqliteSnapshot(sourcePath: string): SnapshotLease {
  const dir = mkdtempSync(join(tmpdir(), 'orca-live-sqlite-'))
  const dbFile = join(dir, 'db.sqlite')
  try {
    copyLiveSqliteFile(sourcePath, dbFile)
    const walPath = `${sourcePath}-wal`
    if (existsSync(walPath)) {
      copyLiveSqliteFile(walPath, `${dbFile}-wal`)
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { dir, dbFile, refs: 0, idleTimer: null }
}

function clearSnapshotIdle(lease: SnapshotLease): void {
  if (lease.idleTimer) {
    clearTimeout(lease.idleTimer)
    lease.idleTimer = null
  }
}

function disposeSnapshot(sourcePath: string, lease: SnapshotLease): void {
  clearSnapshotIdle(lease)
  snapshotLeases.delete(sourcePath)
  rmSync(lease.dir, { recursive: true, force: true })
}

function acquireSnapshot(sourcePath: string): { dbFile: string; release: () => void } {
  let lease = snapshotLeases.get(sourcePath)
  if (!lease) {
    lease = copyLiveSqliteSnapshot(sourcePath)
    snapshotLeases.set(sourcePath, lease)
  } else {
    clearSnapshotIdle(lease)
  }
  lease.refs += 1
  let released = false
  return {
    dbFile: lease.dbFile,
    release: () => {
      if (released) {
        return
      }
      released = true
      const current = snapshotLeases.get(sourcePath)
      if (!current) {
        return
      }
      current.refs = Math.max(0, current.refs - 1)
      if (current.refs > 0) {
        return
      }
      clearSnapshotIdle(current)
      current.idleTimer = setTimeout(() => {
        const idle = snapshotLeases.get(sourcePath)
        if (idle && idle.refs === 0) {
          disposeSnapshot(sourcePath, idle)
        }
      }, SNAPSHOT_IDLE_MS)
      current.idleTimer.unref?.()
    }
  }
}

function openSnapshotReadonly(sourcePath: string): SyncDatabase {
  const snapshot = acquireSnapshot(sourcePath)
  try {
    return configureQueryOnly(new SnapshotReadonlyDatabase(snapshot.dbFile, snapshot.release))
  } catch (error) {
    snapshot.release()
    throw error
  }
}

export function flushLiveSqliteSnapshotsForTests(): void {
  for (const [sourcePath, lease] of snapshotLeases) {
    disposeSnapshot(sourcePath, lease)
  }
}

/**
 * Open another process's SQLite database for reading without waiting on its
 * write lock. Uncontended files open in place; a busy database is copied
 * (db + WAL only) and the copy is read. The original files are never mutated,
 * checkpointed, or deleted.
 */
export function openLiveSqliteReadonly(dbPath: string): SyncDatabase {
  try {
    return configureQueryOnly(
      new SyncDatabase(dbPath, { readonly: true, fileMustExist: true, timeout: 0 })
    )
  } catch (error) {
    if (!isSqliteBusyError(error)) {
      throw error
    }
  }
  try {
    return openSnapshotReadonly(dbPath)
  } catch (error) {
    throw error instanceof LiveSqliteUnavailableError
      ? error
      : new LiveSqliteUnavailableError(error)
  }
}
