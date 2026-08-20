import { describe, expect, it } from 'vitest'
import { isAgentNoticeMessage } from '../../shared/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

const LOGIN_NOTICE =
  'Remote Control disconnected — Your organization requires Trusted Devices for Remote Control, but this device is not enrolled. Please run `/login` in Claude Code to enroll this device.'

function decode(record: Record<string, unknown>) {
  return decodeClaudeTranscriptLine(JSON.stringify(record), 'fallback')
}

describe('decodeClaudeTranscriptLine — system notices', () => {
  it('surfaces a type:system subtype:informational login notice as an agent notice', () => {
    const decoded = decode({
      type: 'system',
      subtype: 'informational',
      content: LOGIN_NOTICE,
      level: 'warning',
      timestamp: '2026-08-13T13:26:51.452Z',
      uuid: '1da9c588-975e-4d06-b023-fba02612707d'
    })

    expect(decoded).toEqual({
      id: '1da9c588-975e-4d06-b023-fba02612707d',
      role: 'system',
      blocks: [{ type: 'text', text: LOGIN_NOTICE }],
      timestamp: Date.parse('2026-08-13T13:26:51.452Z'),
      source: 'transcript',
      noticeKind: 'agent-notice',
      noticeLevel: 'warning'
    })
    expect(isAgentNoticeMessage(decoded!)).toBe(true)
  })

  it('surfaces an unknown future subtype when it carries user-facing copy', () => {
    const decoded = decode({
      type: 'system',
      subtype: 'trusted_device_required',
      content: 'Enroll this device to continue Remote Control.',
      level: 'warning',
      timestamp: '2026-08-20T00:00:00.000Z',
      uuid: 'future-notice'
    })

    expect(decoded).toMatchObject({
      id: 'future-notice',
      role: 'system',
      noticeKind: 'agent-notice',
      noticeLevel: 'warning',
      blocks: [{ type: 'text', text: 'Enroll this device to continue Remote Control.' }]
    })
    expect(isAgentNoticeMessage(decoded!)).toBe(true)
  })

  it('keeps known telemetry subtypes silent even when they carry extra fields', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'stop_hook_summary',
        hookCount: 3,
        timestamp: '2026-08-13T14:44:23.786Z',
        uuid: 'e6f19769-d9b9-44eb-86e4-0092bf4cf6da'
      })
    ).toBeNull()
    expect(
      decode({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 5419,
        timestamp: '2026-08-13T14:44:23.787Z',
        uuid: 'cb4072ea-68ed-4140-a552-08de711c002b'
      })
    ).toBeNull()
    expect(
      decode({
        type: 'system',
        subtype: 'away_summary',
        content: 'PR #11417 is finalized and the evidence comment is posted.',
        uuid: 'away-1'
      })
    ).toBeNull()
    expect(
      decode({
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/login</command-name>',
        uuid: 'cmd-1'
      })
    ).toBeNull()
  })

  it('surfaces api_error copy from the structured error payload', () => {
    const decoded = decode({
      type: 'system',
      subtype: 'api_error',
      level: 'error',
      error: {
        message: 'Connection error.',
        formatted: 'Unable to connect to API (ECONNRESET)'
      },
      uuid: 'api-err-1',
      timestamp: '2026-07-27T22:36:42.173Z'
    })

    expect(decoded).toMatchObject({
      id: 'api-err-1',
      role: 'system',
      noticeKind: 'agent-notice',
      noticeLevel: 'error',
      blocks: [{ type: 'text', text: 'Unable to connect to API (ECONNRESET)' }]
    })
  })

  it('surfaces model_refusal_fallback and compact_boundary copy as notices', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'model_refusal_fallback',
        content: "Fable 5's safeguards flagged this message. Switched to Opus 4.8.",
        level: 'warning',
        uuid: 'refusal-1'
      })
    ).toMatchObject({
      noticeKind: 'agent-notice',
      noticeLevel: 'warning',
      blocks: [
        {
          type: 'text',
          text: "Fable 5's safeguards flagged this message. Switched to Opus 4.8."
        }
      ]
    })
    expect(
      decode({
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        uuid: 'compact-1'
      })
    ).toMatchObject({
      noticeKind: 'agent-notice',
      noticeLevel: 'info',
      blocks: [{ type: 'text', text: 'Conversation compacted' }]
    })
  })

  it('drops an informational notice with no extractable copy instead of a blank banner', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'informational',
        timestamp: '2026-08-13T13:00:00.000Z',
        uuid: 'notice-empty'
      })
    ).toBeNull()
  })

  it('drops an unknown subtype that has no extractable copy', () => {
    expect(
      decode({
        type: 'system',
        subtype: 'future_telemetry',
        durationMs: 12,
        uuid: 'future-empty'
      })
    ).toBeNull()
  })

  it('does not mark ordinary assistant turns or interrupt status as agent notices', () => {
    const assistant = decode({
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'Hola' }] },
      timestamp: '2026-08-13T14:44:23.542Z',
      uuid: '18d90d27-d0f1-481b-9735-b18b5f005307'
    })
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.noticeKind).toBeUndefined()
    expect(isAgentNoticeMessage(assistant!)).toBe(false)

    const interrupted = decode({
      type: 'user',
      uuid: 'interrupt-row',
      interruptedMessageId: 'assistant-request-1',
      timestamp: '2026-07-16T23:46:01.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }]
      }
    })
    expect(interrupted?.role).toBe('system')
    expect(interrupted?.noticeKind).toBeUndefined()
    expect(isAgentNoticeMessage(interrupted!)).toBe(false)
  })
})
