import { describe, expect, it } from 'vitest'
import { buildOrchestrationRecoveryCommand } from './orchestration-recovery-command'

describe('orchestration recovery command identity', () => {
  it('reconstructs the keyed worker-start command from its RPC params', () => {
    expect(
      buildOrchestrationRecoveryCommand('orchestration.workerStart', {
        task: 'task_1',
        on: 'windows',
        worktree: 'new-top-level',
        timeoutMs: 90_000,
        devMode: false
      })
    ).toEqual([
      'orca',
      'orchestration',
      'worker-start',
      '--task',
      'task_1',
      '--on',
      'windows',
      '--worktree',
      'new-top-level',
      '--timeout-ms',
      '90000'
    ])
  })

  it('does not fabricate identity for unsupported mutations or malformed params', () => {
    expect(buildOrchestrationRecoveryCommand('orchestration.send', {})).toBeUndefined()
    expect(buildOrchestrationRecoveryCommand('orchestration.workerStart', null)).toBeUndefined()
  })
})
