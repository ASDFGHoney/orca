import { describe, expect, it } from 'vitest'
import {
  parseMessageGraphSessionContent,
  type MessageGraphAgent
} from './session-scanner-graph-parsers'
import type { FileWithMtime } from './session-scanner-types'

function graphFile(sessionFile: string): FileWithMtime {
  return {
    path: `/tmp/${sessionFile}`,
    mtimeMs: 1,
    modifiedAt: '2026-05-01T10:00:00.000Z'
  }
}

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

async function parseGraph(
  agent: MessageGraphAgent,
  records: unknown[],
  sessionFile = `${agent}-session.jsonl`
) {
  return parseMessageGraphSessionContent(agent, graphFile(sessionFile), jsonl(records), 'darwin')
}

const firstPrompt = {
  type: 'message',
  timestamp: '2026-05-01T10:00:05.000Z',
  message: { role: 'user', content: 'first user prompt' }
}

describe('message-graph harness session titles', () => {
  it('uses the latest Pi session_info.name ahead of the first user prompt', async () => {
    const session = await parseGraph('pi', [
      {
        type: 'session',
        id: 'pi-session',
        cwd: '/tmp/pi',
        timestamp: '2026-05-01T10:00:00.000Z'
      },
      firstPrompt,
      { type: 'session_info', name: 'old name', timestamp: '2026-05-01T10:00:10.000Z' },
      { type: 'session_info', name: '111', timestamp: '2026-05-01T10:00:20.000Z' }
    ])
    expect(session?.title).toBe('111')
  })

  it('keeps the first Pi user prompt when no session_info name exists', async () => {
    const session = await parseGraph('pi', [
      {
        type: 'session',
        id: 'pi-session',
        cwd: '/tmp/pi',
        timestamp: '2026-05-01T10:00:00.000Z'
      },
      firstPrompt
    ])
    expect(session?.title).toBe('first user prompt')
  })

  it('uses the OMP session header title ahead of the first user prompt', async () => {
    const session = await parseGraph('omp', [
      {
        type: 'session',
        version: 3,
        id: 'omp-session',
        cwd: '/tmp/omp',
        title: 'OMP session title',
        timestamp: '2026-05-01T10:00:00.000Z'
      },
      firstPrompt
    ])
    expect(session?.title).toBe('OMP session title')
  })

  it('lets a later OMP user title replace an automatic title', async () => {
    const session = await parseGraph('omp', [
      {
        type: 'title',
        v: 1,
        title: 'auto generated',
        source: 'auto',
        updatedAt: '2026-05-01T10:00:00.000Z',
        pad: ''
      },
      {
        type: 'session',
        version: 3,
        id: 'omp-session',
        cwd: '/tmp/omp',
        title: 'auto generated',
        titleSource: 'auto',
        timestamp: '2026-05-01T10:00:00.000Z'
      },
      firstPrompt,
      {
        type: 'title_change',
        title: 'useful title',
        source: 'user',
        timestamp: '2026-05-01T10:00:30.000Z'
      }
    ])
    expect(session?.title).toBe('useful title')
  })

  it('does not let an automatic OMP title overwrite a user title', async () => {
    const session = await parseGraph('omp', [
      {
        type: 'session',
        version: 3,
        id: 'omp-session',
        cwd: '/tmp/omp',
        title: 'useful title',
        titleSource: 'user',
        timestamp: '2026-05-01T10:00:00.000Z'
      },
      firstPrompt,
      {
        type: 'title_change',
        title: 'auto generated',
        source: 'auto',
        timestamp: '2026-05-01T10:00:30.000Z'
      }
    ])
    expect(session?.title).toBe('useful title')
  })

  it('uses a user title slot even after a later first prompt', async () => {
    const session = await parseGraph('omp', [
      {
        type: 'title',
        v: 1,
        title: 'useful title',
        source: 'user',
        updatedAt: '2026-05-01T10:00:00.000Z',
        pad: ''
      },
      {
        type: 'session',
        version: 3,
        id: 'omp-session',
        cwd: '/tmp/omp',
        timestamp: '2026-05-01T10:00:00.000Z'
      },
      firstPrompt
    ])
    expect(session?.title).toBe('useful title')
  })
})
