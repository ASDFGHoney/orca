import { describe, expect, it } from 'vitest'
import {
  buildOrchestrationRecoveryCommand,
  resolveOrchestrationCliExecutable
} from './orchestration-recovery-command'

describe('orchestration recovery command identity', () => {
  it('resolves dev, packaged, and execution-host CLI names without rewriting them', () => {
    expect(resolveOrchestrationCliExecutable({ ORCA_CLI_COMMAND: 'orca-dev' }, 'darwin')).toBe(
      'orca-dev'
    )
    expect(resolveOrchestrationCliExecutable({ ORCA_CLI_COMMAND: 'orca-ide' }, 'win32')).toBe(
      'orca-ide'
    )
    expect(resolveOrchestrationCliExecutable({ ORCA_DEV_REPO_ROOT: '/repo' }, 'darwin')).toBe(
      'orca-dev'
    )
    expect(resolveOrchestrationCliExecutable({}, 'linux')).toBe('orca-ide')
    expect(resolveOrchestrationCliExecutable({}, 'darwin')).toBe('orca')
  })

  it('reconstructs the keyed worker-start command from its RPC params', () => {
    expect(
      buildOrchestrationRecoveryCommand(
        'orchestration.workerStart',
        {
          task: 'task_1',
          on: 'windows',
          worktree: 'new-top-level',
          timeoutMs: 90_000,
          devMode: false
        },
        'orca'
      )
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

  it('preserves the selected executable and raw command arguments', () => {
    expect(
      buildOrchestrationRecoveryCommand(
        'orchestration.workerStart',
        { task: 'task_1' },
        'orca-dev',
        [
          'orchestration',
          'worker-start',
          '--task',
          'task_1',
          '--comment',
          'literal $(do-not-run) "quoted"',
          '--json'
        ]
      )
    ).toEqual([
      'orca-dev',
      'orchestration',
      'worker-start',
      '--task',
      'task_1',
      '--comment',
      'literal $(do-not-run) "quoted"',
      '--json'
    ])
  })

  it('supports the explicit executable-first form', () => {
    expect(
      buildOrchestrationRecoveryCommand('orca-ide', 'orchestration.workerStop', {
        dispatch: 'dispatch_1'
      })
    ).toEqual(['orca-ide', 'orchestration', 'worker-stop', '--dispatch', 'dispatch_1'])
  })

  it('does not fabricate identity for unsupported mutations or malformed params', () => {
    expect(buildOrchestrationRecoveryCommand('orchestration.send', {})).toBeUndefined()
    expect(buildOrchestrationRecoveryCommand('orchestration.workerStart', null)).toBeUndefined()
  })
})
