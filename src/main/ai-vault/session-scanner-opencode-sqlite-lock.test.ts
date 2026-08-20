import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  flushLiveSqliteSnapshotsForTests,
  setLiveSqliteFileCopyForTests
} from '../sqlite/live-sqlite-readonly'
import Database from '../sqlite/sync-database'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'

let tempDirs: string[] = []

afterEach(() => {
  setLiveSqliteFileCopyForTests(null)
  flushLiveSqliteSnapshotsForTests()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createLockedOpenCodeDb(): { writer: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-sqlite-lock-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  const writer = new Database(path)
  writer.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    INSERT INTO session VALUES ('ses_locked', 1777634000000, 1777634001000);
    BEGIN EXCLUSIVE;
  `)
  return { writer, path }
}

describe('listOpenCodeSqliteSessions under a live writer lock', () => {
  it('lists sessions from a contended database without a raw sqlite lock string', async () => {
    const { writer, path } = createLockedOpenCodeDb()
    try {
      const issues: AiVaultScanIssue[] = []
      const candidates = await listOpenCodeSqliteSessions({
        dbPaths: [path],
        limit: 10,
        issues
      })
      expect(JSON.stringify(issues)).not.toMatch(/database is locked/i)
      expect(candidates.map((candidate) => candidate.file.path)).toEqual([
        buildOpenCodeSqliteCandidatePath(path, 'ses_locked')
      ])
      expect(issues).toEqual([])
    } finally {
      writer.exec('COMMIT')
      writer.close()
    }
  })

  it('surfaces a retryable unavailable notice when the contended DB cannot be snapshotted', async () => {
    const { writer, path } = createLockedOpenCodeDb()
    setLiveSqliteFileCopyForTests(() => {
      throw new Error('EPERM: copy blocked')
    })
    try {
      const issues: AiVaultScanIssue[] = []
      const candidates = await listOpenCodeSqliteSessions({
        dbPaths: [path],
        limit: 10,
        issues
      })
      expect(candidates).toEqual([])
      expect(issues).toHaveLength(1)
      expect(issues[0]?.kind).toBe('notice')
      expect(issues[0]?.agent).toBe('opencode')
      expect(issues[0]?.path).toBe(path)
      expect(issues[0]?.message).toMatch(/temporarily unavailable/i)
      expect(issues[0]?.message).not.toMatch(/database is locked/i)
      expect(issues.filter((issue) => !issue.kind)).toEqual([])
    } finally {
      writer.exec('COMMIT')
      writer.close()
    }
  })

  it('recovers the session list on the next scan after the writer releases', async () => {
    const { writer, path } = createLockedOpenCodeDb()
    setLiveSqliteFileCopyForTests(() => {
      throw new Error('EPERM: copy blocked')
    })
    const lockedIssues: AiVaultScanIssue[] = []
    const locked = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues: lockedIssues
    })
    expect(locked).toEqual([])
    expect(lockedIssues[0]?.kind).toBe('notice')

    setLiveSqliteFileCopyForTests(null)
    writer.exec('COMMIT')
    writer.close()

    const recoveredIssues: AiVaultScanIssue[] = []
    const recovered = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues: recoveredIssues
    })
    expect(recoveredIssues).toEqual([])
    expect(recovered.map((candidate) => candidate.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(path, 'ses_locked')
    ])
  })

  it('still lists an uncontended readable database', async () => {
    const { writer, path } = createLockedOpenCodeDb()
    writer.exec('COMMIT')
    writer.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues
    })
    expect(issues).toEqual([])
    expect(candidates).toHaveLength(1)
  })
})

describe('parseOpenCodeSqliteSession under a live writer lock', () => {
  it('parses a contended session without throwing a raw sqlite lock string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-sqlite-parse-lock-'))
    tempDirs.push(dir)
    const path = join(dir, 'opencode.db')
    const writer = new Database(path)
    writer.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER,
        agent TEXT,
        model TEXT,
        cost REAL DEFAULT 0 NOT NULL,
        tokens_input INTEGER DEFAULT 0 NOT NULL,
        tokens_output INTEGER DEFAULT 0 NOT NULL,
        tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
        tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
        tokens_cache_write INTEGER DEFAULT 0 NOT NULL
      );
      INSERT INTO session (
        id, project_id, slug, directory, title, version,
        time_created, time_updated, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (
        'ses_locked', 'proj-1', 'slug', '/tmp/opencode', 'Locked session', '1.0.0',
        1777634000000, 1777634001000, 0, 1, 1, 0, 0, 0
      );
      BEGIN EXCLUSIVE;
    `)
    try {
      const session = await parseOpenCodeSqliteSession({
        dbPath: path,
        sessionId: 'ses_locked',
        platform: 'darwin'
      })
      expect(session).not.toBeNull()
      expect(session?.sessionId).toBe('ses_locked')
      expect(session?.title).toBe('Locked session')
    } finally {
      writer.exec('COMMIT')
      writer.close()
    }
  })
})
