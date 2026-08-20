import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushLiveSqliteSnapshotsForTests,
  isLiveSqliteUnavailableError,
  LiveSqliteUnavailableError,
  openLiveSqliteReadonly,
  setLiveSqliteFileCopyForTests
} from './live-sqlite-readonly'
import SyncDatabase from './sync-database'

let tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  setLiveSqliteFileCopyForTests(null)
  flushLiveSqliteSnapshotsForTests()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createLockedDb(): { writer: SyncDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-live-sqlite-'))
  tempDirs.push(dir)
  const path = join(dir, 'sessions.db')
  const writer = new SyncDatabase(path)
  writer.exec('CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1); BEGIN EXCLUSIVE')
  return { writer, path }
}

describe('openLiveSqliteReadonly', () => {
  it('reads an uncontended database in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-live-sqlite-'))
    tempDirs.push(dir)
    const path = join(dir, 'sessions.db')
    const writer = new SyncDatabase(path)
    writer.exec('CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (7)')
    writer.close()

    const db = openLiveSqliteReadonly(path)
    expect(db.pragma('query_only', { simple: true })).toBe(1)
    expect(db.prepare('SELECT id FROM items').get()).toEqual({ id: 7 })
    expect(() => db.exec('INSERT INTO items VALUES (8)')).toThrow()
    db.close()
  })

  it('reads through a snapshot when the live database is exclusively locked', () => {
    const { writer, path } = createLockedDb()
    try {
      const db = openLiveSqliteReadonly(path)
      expect(db.prepare('SELECT id FROM items').get()).toEqual({ id: 1 })
      db.close()
      expect(existsSync(path)).toBe(true)
      expect(existsSync(`${path}-wal`)).toBe(false)
    } finally {
      writer.exec('COMMIT')
      writer.close()
    }
  })

  it('throws a retryable unavailable error when a locked database cannot be copied', () => {
    const { writer, path } = createLockedDb()
    setLiveSqliteFileCopyForTests(() => {
      throw new Error('EPERM: copy blocked')
    })
    try {
      expect(() => openLiveSqliteReadonly(path)).toThrow(LiveSqliteUnavailableError)
      try {
        openLiveSqliteReadonly(path)
      } catch (error) {
        expect(isLiveSqliteUnavailableError(error)).toBe(true)
        expect(error).toBeInstanceOf(LiveSqliteUnavailableError)
        expect(String(error)).not.toMatch(/database is locked/i)
      }
    } finally {
      writer.exec('COMMIT')
      writer.close()
    }
  })

  it('closes the handle when query_only setup fails on an uncontended file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-live-sqlite-'))
    tempDirs.push(dir)
    const path = join(dir, 'sessions.db')
    const writer = new SyncDatabase(path)
    writer.exec('CREATE TABLE items (id INTEGER)')
    writer.close()

    const setupError = new Error('query_only setup failed')
    vi.spyOn(SyncDatabase.prototype, 'pragma').mockImplementationOnce(() => {
      throw setupError
    })
    const closeSpy = vi.spyOn(SyncDatabase.prototype, 'close')

    expect(() => openLiveSqliteReadonly(path)).toThrow(setupError)
    expect(closeSpy).toHaveBeenCalled()
  })
})
