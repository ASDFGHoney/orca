import { applyClaudeEnvPatch } from '../claude-accounts/environment'

const CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID'
] as const

function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

export function buildClaudeChildProcessEnv(
  configuredEnv: Record<string, string> = {}
): Record<string, string> {
  const env = applyClaudeEnvPatch(cloneProcessEnv(), {}, { stripAuthEnv: true })
  for (const key of CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS) {
    delete env[key]
  }
  return Object.assign(env, configuredEnv)
}
