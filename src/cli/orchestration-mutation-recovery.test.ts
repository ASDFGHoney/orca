import { describe, expect, it } from 'vitest'
import {
  orchestrationMutationRecoveryError,
  renderCommand
} from './orchestration-mutation-recovery'
import { RuntimeClientError } from './runtime-client'

describe('orchestration mutation recovery', () => {
  it('queries a known dispatch before issuing the keyed retry', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_1',
        dispatchId: 'dispatch_1',
        originalCommand: ['orca', 'orchestration', 'worker-start', '--task', 'task_1']
      })
    ) as RuntimeClientError

    expect(result.data).toMatchObject({
      recovery: {
        orchestrationRequestId: 'request_1',
        dispatchId: 'dispatch_1',
        queryCommand: [
          'orca',
          'orchestration',
          'worker-show',
          '--dispatch',
          'dispatch_1',
          '--json'
        ],
        retryCommand: [
          'orca',
          'orchestration',
          'worker-start',
          '--task',
          'task_1',
          '--retry-request',
          'request_1'
        ],
        workerDeathInferred: false
      }
    })
    expect(result.message.indexOf('orca orchestration worker-show')).toBeLessThan(
      result.message.indexOf('orca orchestration worker-start')
    )
    expect((result.data as { nextSteps?: string[] }).nextSteps).toEqual([
      'Run orca orchestration worker-show --dispatch dispatch_1 --json before retrying.',
      'Run orca orchestration worker-start --task task_1 --retry-request request_1.'
    ])
  })

  it('does not invent a dispatch for an old-client-shaped error', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_2',
        originalCommand: ['orca', 'orchestration', 'worker-start', '--task', 'task_2']
      })
    ) as RuntimeClientError

    expect(result.data).toMatchObject({
      recovery: {
        orchestrationRequestId: 'request_2',
        retryCommand: expect.arrayContaining(['--retry-request', 'request_2']),
        workerDeathInferred: false
      }
    })
    expect((result.data as Record<string, unknown>).recovery).not.toHaveProperty('dispatchId')
    expect(result.message).not.toContain('worker death')
  })

  it('renders the exact executable and safely quotes original arguments', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_3',
        dispatchId: 'dispatch_3',
        originalCommand: [
          'orca-dev',
          'orchestration',
          'worker-start',
          '--task',
          'task 3',
          '--comment',
          'literal $(do-not-run)'
        ]
      })
    ) as RuntimeClientError

    expect((result.data as { nextSteps?: string[] }).nextSteps).toEqual([
      'Run orca-dev orchestration worker-show --dispatch dispatch_3 --json before retrying.',
      "Run orca-dev orchestration worker-start --task 'task 3' --comment 'literal $(do-not-run)' --retry-request request_3."
    ])
    expect(result.message).toContain("'literal $(do-not-run)'")
  })

  it('parses legacy command text without losing quoted arguments', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_4',
        originalCommand:
          'orca-ide orchestration worker-stop --dispatch dispatch_4 --comment "quoted value"'
      })
    ) as RuntimeClientError

    expect(
      (result.data as { recovery?: { retryCommand?: string[] } }).recovery?.retryCommand
    ).toEqual([
      'orca-ide',
      'orchestration',
      'worker-stop',
      '--dispatch',
      'dispatch_4',
      '--comment',
      'quoted value',
      '--retry-request',
      'request_4'
    ])
  })

  it('renders Windows cmd recovery guidance without quote drift or percent expansion', () => {
    expect(
      renderCommand(
        ['orca', 'orchestration', 'worker-start', '--comment', 'literal "quoted" %PATH% & safe'],
        'win32',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      )
    ).toBe(
      '"orca" "orchestration" "worker-start" "--comment" "literal ""quoted"" "^%"PATH"^%" & safe"'
    )
  })

  it('keeps PowerShell and POSIX recovery guidance literal', () => {
    expect(
      renderCommand(['orca', 'literal "quoted" $HOME'], 'win32', {
        ComSpec: 'powershell.exe'
      })
    ).toBe("& 'orca' 'literal \\\"quoted\\\" $HOME'")
    expect(renderCommand(['orca', 'literal $(do-not-run)'], 'darwin')).toBe(
      "orca 'literal $(do-not-run)'"
    )
  })
})
