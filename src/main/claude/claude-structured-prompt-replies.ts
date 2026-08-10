import type { ClaudeControlRequest } from './claude-stream-json-connection'

export const CLAUDE_APPROVAL_DECISIONS = ['allow', 'allowForSession', 'deny', 'cancel'] as const
export type ClaudeApprovalDecision = (typeof CLAUDE_APPROVAL_DECISIONS)[number]

export type ClaudePendingPrompt = {
  requestId: string
  promptKey: string
  toolUseId: string
  toolName: string
  kind: 'approval' | 'question'
  input: Record<string, unknown>
  suggestions: unknown[]
  questionIds: readonly string[]
  answers: Map<string, string>
  request: ClaudeControlRequest['request']
}

type PromptBinding = {
  address: string
  questionId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function questionsFrom(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input.questions) ? input.questions.filter(isRecord) : []
}

function questionId(question: Record<string, unknown>, index: number): string {
  return readString(question.question) ?? readString(question.header) ?? `question-${index + 1}`
}

export function encodeClaudeQuestionOptionId(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function decodeClaudeQuestionOptionId(
  optionId: string
): { questionId: string; answer: string } | null {
  const separator = optionId.indexOf(':')
  if (separator <= 0) {
    return null
  }
  try {
    return {
      questionId: decodeURIComponent(optionId.slice(0, separator)),
      answer: decodeURIComponent(optionId.slice(separator + 1))
    }
  } catch {
    return null
  }
}

export class ClaudePromptRegistry {
  private readonly prompts = new Map<string, ClaudePendingPrompt>()
  private readonly journalBindings = new Map<string, PromptBinding>()

  register(control: ClaudeControlRequest): ClaudePendingPrompt | null {
    if (control.request.subtype !== 'can_use_tool') {
      return null
    }
    const toolUseId = readString(control.request.tool_use_id)
    const toolName = readString(control.request.tool_name)
    const input = isRecord(control.request.input) ? control.request.input : null
    if (!toolUseId || !toolName || !input) {
      return null
    }
    const questions = toolName === 'AskUserQuestion' ? questionsFrom(input) : []
    const prompt: ClaudePendingPrompt = {
      requestId: control.request_id,
      promptKey: control.request_id,
      toolUseId,
      toolName,
      kind: questions.length > 0 ? 'question' : 'approval',
      input,
      suggestions: Array.isArray(control.request.permission_suggestions)
        ? control.request.permission_suggestions
        : [],
      questionIds: questions.map(questionId),
      answers: new Map(),
      request: control.request
    }
    this.prompts.set(prompt.promptKey, prompt)
    return prompt
  }

  bindJournalItemId(journalItemId: string, promptKey: string, questionIdForItem?: string): void {
    this.journalBindings.set(journalItemId, {
      address: promptKey,
      ...(questionIdForItem ? { questionId: questionIdForItem } : {})
    })
  }

  find(itemId: string): { prompt: ClaudePendingPrompt; questionId?: string } | null {
    const binding = this.journalBindings.get(itemId)
    const prompt = this.prompts.get(binding?.address ?? itemId)
    return prompt
      ? { prompt, ...(binding?.questionId ? { questionId: binding.questionId } : {}) }
      : null
  }

  cancel(requestId: string): ClaudePendingPrompt | null {
    const prompt = this.prompts.get(requestId) ?? null
    if (prompt) {
      this.forget(prompt)
    }
    return prompt
  }

  forget(prompt: ClaudePendingPrompt): void {
    this.prompts.delete(prompt.promptKey)
    for (const [itemId, binding] of this.journalBindings) {
      if (binding.address === prompt.promptKey) {
        this.journalBindings.delete(itemId)
      }
    }
  }

  clear(): ClaudePendingPrompt[] {
    const pending = [...this.prompts.values()]
    this.prompts.clear()
    this.journalBindings.clear()
    return pending
  }
}

function approvalResponse(prompt: ClaudePendingPrompt, optionId: string): Record<string, unknown> {
  if (!(CLAUDE_APPROVAL_DECISIONS as readonly string[]).includes(optionId)) {
    throw new Error(`${optionId} is not a Claude approval decision`)
  }
  const decision = optionId as ClaudeApprovalDecision
  if (decision === 'allow' || decision === 'allowForSession') {
    return {
      behavior: 'allow',
      updatedInput: prompt.input,
      ...(decision === 'allowForSession' && prompt.suggestions.length > 0
        ? { updatedPermissions: prompt.suggestions }
        : {}),
      toolUseID: prompt.toolUseId
    }
  }
  return {
    behavior: 'deny',
    message: decision === 'cancel' ? 'User stopped this turn.' : 'User denied this action.',
    ...(decision === 'cancel' ? { interrupt: true } : {}),
    toolUseID: prompt.toolUseId
  }
}

function questionResponse(
  prompt: ClaudePendingPrompt,
  optionId: string,
  boundQuestionId?: string
): Record<string, unknown> | null {
  const decoded = decodeClaudeQuestionOptionId(optionId)
  const selectedQuestionId =
    decoded?.questionId ??
    boundQuestionId ??
    (prompt.questionIds.length === 1 ? prompt.questionIds[0] : null)
  const answer = decoded?.answer ?? optionId
  if (!selectedQuestionId || !prompt.questionIds.includes(selectedQuestionId)) {
    throw new Error(`${optionId} does not name a question on Claude prompt ${prompt.promptKey}`)
  }
  prompt.answers.set(selectedQuestionId, answer)
  if (prompt.questionIds.some((id) => !prompt.answers.has(id))) {
    return null
  }
  const answers: Record<string, string> = {}
  for (const id of prompt.questionIds) {
    answers[id] = prompt.answers.get(id) as string
  }
  return {
    behavior: 'allow',
    updatedInput: { ...prompt.input, answers },
    toolUseID: prompt.toolUseId
  }
}

export function applyClaudePromptAnswer(
  found: { prompt: ClaudePendingPrompt; questionId?: string },
  optionId: string
): Record<string, unknown> | null {
  return found.prompt.kind === 'approval'
    ? approvalResponse(found.prompt, optionId)
    : questionResponse(found.prompt, optionId, found.questionId)
}
