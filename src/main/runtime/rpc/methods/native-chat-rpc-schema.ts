import { z } from 'zod'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'
import type { AgentType } from '../../../../shared/native-chat-types'

export const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000

const NativeChatProviderSession = z.unknown().transform((value, context) => {
  const normalized = normalizeAgentProviderSession(value)
  if (!normalized) {
    context.addIssue({ code: 'custom', message: 'Invalid provider session' })
    return z.NEVER
  }
  return normalized
})

export const NativeChatSession = z.object({
  agent: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, 'Missing agent'))
    .transform((value) => value as AgentType),
  sessionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, 'Missing session id')),
  limit: z
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, MOBILE_NATIVE_CHAT_MAX_WINDOW))
    .optional(),
  subscriptionId: z.string().min(1).optional(),
  transcriptPath: z.string().min(1).optional(),
  providerSession: NativeChatProviderSession.optional(),
  beforeOffset: z.number().int().nonnegative().optional()
})

export const NativeChatUnsubscribe = z.object({
  subscriptionId: z.string().min(1).optional()
})
