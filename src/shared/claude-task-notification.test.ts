import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseClaudeTaskNotificationLine,
  readClaudeTerminalTaskNotificationIds,
  readClaudeTerminalTaskNotifications
} from './claude-task-notification'

function notificationRecord(taskId: string, status: string): string {
  return JSON.stringify({
    type: 'queue-operation',
    content:
      `<task-notification>\n<task-id>${taskId}</task-id>\n` +
      `<status>${status}</status>\n</task-notification>`
  })
}

describe('Claude task notifications', () => {
  it('parses queue and user delivery shapes but not quoted prose', () => {
    expect(parseClaudeTaskNotificationLine(notificationRecord('task-1', 'completed'))).toEqual({
      taskId: 'task-1',
      status: 'completed'
    })
    expect(
      parseClaudeTaskNotificationLine(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: '<task-notification><task-id>task-2</task-id><status>failed</status></task-notification>'
              }
            ]
          }
        })
      )
    ).toEqual({ taskId: 'task-2', status: 'failed' })
    expect(
      parseClaudeTaskNotificationLine(
        JSON.stringify({
          type: 'user',
          message: {
            content:
              'Explain <task-notification><task-id>task-3</task-id><status>completed</status></task-notification>'
          }
        })
      )
    ).toBeNull()
  })

  it('returns only terminal task ids from the bounded transcript reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-task-notification-'))
    const transcriptPath = join(dir, 'session.jsonl')
    writeFileSync(
      transcriptPath,
      [
        notificationRecord('running-task', 'running'),
        notificationRecord('completed-task', 'completed'),
        notificationRecord('killed-task', 'killed')
      ].join('\n')
    )
    try {
      expect(readClaudeTerminalTaskNotificationIds(transcriptPath)).toEqual(
        new Set(['completed-task', 'killed-task'])
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a partial JSONL record at the ownership offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-task-offset-'))
    const transcriptPath = join(dir, 'session.jsonl')
    const partialRecord = '{"type":"user","message":{"content":"'
    writeFileSync(transcriptPath, partialRecord)
    try {
      appendFileSync(
        transcriptPath,
        `continued"}}\n${notificationRecord('later-task', 'completed')}\n`
      )

      expect(readClaudeTerminalTaskNotifications(transcriptPath, partialRecord.length)).toEqual([
        expect.objectContaining({ taskId: 'later-task', status: 'completed' })
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a partial first record at the bounded scan boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-task-boundary-'))
    const transcriptPath = join(dir, 'session.jsonl')
    writeFileSync(
      transcriptPath,
      `${'x'.repeat(4 * 1024 * 1024 + 256)}\n${notificationRecord('tail-task', 'failed')}\n`
    )
    try {
      expect(readClaudeTerminalTaskNotificationIds(transcriptPath)).toEqual(new Set(['tail-task']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
