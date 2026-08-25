import { CLAUDE_DEFAULT_SETTING_SOURCES } from './claude-structured-launch-resolution'
import type { ClaudeAuthDiagnostic } from './claude-structured-session-state'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type ClaudeInitObservation = {
  providerSessionId: string
  uuid: string | null
  message: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readClaudeFrameString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The durable Claude branch marker is the UUID on a root user prompt. Result,
 * assistant, and tool-result frames also carry UUIDs, but those are item
 * identities rather than the transcript's resumable leaf.
 */
export function readClaudeRootUserFrameUuid(
  message: Record<string, unknown>,
  sessionId?: string
): string | null {
  if (
    message.type !== 'user' ||
    message.parent_tool_use_id !== null ||
    (sessionId !== undefined && readClaudeFrameString(message, 'session_id') !== sessionId)
  ) {
    return null
  }
  const body = message.message
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null
  }
  const content = (body as { content?: unknown }).content
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result'
    )
  ) {
    return null
  }
  return readClaudeFrameString(message, 'uuid')
}

export function readClaudeInit(message: Record<string, unknown>): ClaudeInitObservation | null {
  const hookName = readClaudeFrameString(message, 'hook_name')
  const isInit = message.type === 'system' && message.subtype === 'init'
  const isSessionStart =
    message.type === 'system' &&
    (message.subtype === 'hook_started' || message.subtype === 'hook_response') &&
    hookName?.startsWith('SessionStart:') === true
  if (!isInit && !isSessionStart) {
    return null
  }
  const providerSessionId = readClaudeFrameString(message, 'session_id')
  return providerSessionId
    ? {
        providerSessionId,
        uuid: isInit ? readClaudeFrameString(message, 'uuid') : null,
        message
      }
    : null
}

export function readClaudeModels(initialization: unknown): unknown[] {
  return isRecord(initialization) && Array.isArray(initialization.models)
    ? initialization.models
    : []
}

export function claudeInitializationAuthError(
  initialization: unknown
): AgentSessionAcquisitionRefusal | null {
  const account =
    isRecord(initialization) && isRecord(initialization.account) ? initialization.account : null
  return readClaudeFrameString(account ?? {}, 'tokenSource') === 'none'
    ? new AgentSessionAcquisitionRefusal(
        'Claude is not signed in for the selected account. Sign in with the Claude CLI for this CLAUDE_CONFIG_DIR, then retry.'
      )
    : null
}

export function claudeAuthDiagnostic(
  init: ClaudeInitObservation,
  settings: unknown
): ClaudeAuthDiagnostic {
  const env = isRecord(settings) && isRecord(settings.env) ? settings.env : {}
  const apiKeySource = readClaudeFrameString(init.message, 'apiKeySource')
  const configured = (key: string): boolean =>
    (typeof env[key] === 'string' && (env[key] as string).trim().length > 0) ||
    Boolean(process.env[key]?.trim())
  return {
    apiKeySourceConfigured: apiKeySource !== null && apiKeySource !== 'none',
    baseUrlConfigured: configured('ANTHROPIC_BASE_URL'),
    authTokenConfigured: configured('ANTHROPIC_AUTH_TOKEN'),
    apiKeyConfigured: configured('ANTHROPIC_API_KEY'),
    settingSources: CLAUDE_DEFAULT_SETTING_SOURCES
  }
}
