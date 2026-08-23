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
      notice: { level: 'warning' }
    })
    expect(isAgentNoticeMessage(decoded!)).toBe(true)
  })

  it.each([
    ['informational', 'Device enrollment required', 'warning', 'warning'],
    ['model_refusal_fallback', 'Switched to a fallback model', 'error', 'error'],
    ['compact_boundary', 'Conversation compacted', 'suggestion', 'info']
  ])('surfaces supported %s copy as an agent notice', (subtype, content, level, expectedLevel) => {
    expect(decode({ type: 'system', subtype, content, level, uuid: `${subtype}-1` })).toMatchObject(
      {
        role: 'system',
        blocks: [{ type: 'text', text: content }],
        notice: { level: expectedLevel }
      }
    )
  })

  it.each([
    {
      type: 'system',
      subtype: 'away_summary',
      content: 'While you were away, Claude completed the requested implementation.',
      uuid: 'away-1'
    },
    {
      type: 'system',
      subtype: 'api_error',
      level: 'error',
      error: { message: 'Connection error.', formatted: 'Unable to connect to API' },
      retryAttempt: 2,
      retryInMs: 1_000,
      source: 'request_retry',
      uuid: 'api-retry-1'
    },
    {
      type: 'system',
      subtype: 'stop_hook_summary',
      content: 'Stop hook completed',
      level: 'suggestion',
      hookCount: 3,
      uuid: 'stop-hook-1'
    },
    {
      type: 'system',
      subtype: 'bridge_status',
      content: 'Bridge connected',
      uuid: 'unknown-1'
    }
  ])('keeps non-message system records silent', (record) => {
    expect(decode(record)).toBeNull()
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

  it('does not mark ordinary assistant turns or interrupt status as agent notices', () => {
    const assistant = decode({
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'Hola' }] },
      timestamp: '2026-08-13T14:44:23.542Z',
      uuid: '18d90d27-d0f1-481b-9735-b18b5f005307'
    })
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.notice).toBeUndefined()
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
    expect(interrupted?.notice).toBeUndefined()
    expect(isAgentNoticeMessage(interrupted!)).toBe(false)
  })
})
