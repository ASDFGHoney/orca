import { CLAUDE_DEFAULT_SETTING_SOURCES } from './claude-structured-launch-resolution'
import type { ClaudeAuthDiagnostic } from './claude-structured-session-state'

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

export function readClaudeInit(message: Record<string, unknown>): ClaudeInitObservation | null {
  if (message.type !== 'system' || message.subtype !== 'init') {
    return null
  }
  const providerSessionId = readClaudeFrameString(message, 'session_id')
  return providerSessionId
    ? {
        providerSessionId,
        uuid: readClaudeFrameString(message, 'uuid'),
        message
      }
    : null
}

export function readClaudeModels(initialization: unknown): unknown[] {
  return isRecord(initialization) && Array.isArray(initialization.models)
    ? initialization.models
    : []
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
