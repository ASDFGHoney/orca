import type { ClaudeSession } from './claude-structured-session-state'

export async function setClaudeStructuredOption(
  session: ClaudeSession,
  input: { key: string; value: string },
  timeoutMs: number | undefined
): Promise<void> {
  const request =
    input.key === 'model'
      ? { subtype: 'set_model', params: { model: input.value } }
      : input.key === 'permissionMode'
        ? { subtype: 'set_permission_mode', params: { mode: input.value } }
        : input.key === 'effort'
          ? { subtype: 'apply_flag_settings', params: { settings: { effortLevel: input.value } } }
          : null
  if (!request) {
    throw new Error(`claude stream-json has no session option named ${input.key}`)
  }
  await session.connection.request(request.subtype, request.params, { timeoutMs })
  session.options.set(input.key, input.value)
}
