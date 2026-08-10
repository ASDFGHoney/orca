import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { claudeQuestionItems } from './claude-structured-prompt-items'
import {
  applyClaudePromptAnswer,
  encodeClaudeQuestionOptionId,
  type ClaudePendingPrompt
} from './claude-structured-prompt-replies'

describe('Claude structured question addressing', () => {
  it('keeps wire IDs bounded while returning the original question and choice', () => {
    const questionId = 'Which option? '.repeat(100)
    const label = 'A detailed choice '.repeat(100)
    const prompt: ClaudePendingPrompt = {
      requestId: 'question-1',
      promptKey: 'question-1',
      toolUseId: 'tool-1',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: { questions: [{ question: questionId, options: [{ label }] }] },
      suggestions: [],
      questionIds: [questionId],
      answers: new Map(),
      request: { subtype: 'can_use_tool' }
    }

    const item = claudeQuestionItems({ sessionId: 'session-1', prompt })[0]!
    expect(agentJournalItemKey(item.identity).length).toBeLessThan(512)
    expect(item.body.options[0]!.id.length).toBeLessThan(512)
    expect(item.body.freeTextQuestionId).toBe('q1')
    expect(
      applyClaudePromptAnswer({ prompt, questionId: item.questionId }, item.body.options[0]!.id)
    ).toMatchObject({
      updatedInput: { answers: { [questionId]: label } }
    })
  })

  it('preserves colon-containing free-text answers', () => {
    const questionId = 'Where should this run?'
    const prompt: ClaudePendingPrompt = {
      requestId: 'question-1',
      promptKey: 'question-1',
      toolUseId: 'tool-1',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: { questions: [{ question: questionId }] },
      suggestions: [],
      questionIds: [questionId],
      answers: new Map(),
      request: { subtype: 'can_use_tool' }
    }
    const answer = 'https://example.test:8443/path'

    expect(
      applyClaudePromptAnswer({ prompt }, encodeClaudeQuestionOptionId('q1', answer))
    ).toMatchObject({
      updatedInput: { answers: { [questionId]: answer } }
    })
  })

  it('preserves comma-separated multi-select answers', () => {
    const questionId = 'Which targets?'
    const prompt: ClaudePendingPrompt = {
      requestId: 'question-1',
      promptKey: 'question-1',
      toolUseId: 'tool-1',
      toolName: 'AskUserQuestion',
      kind: 'question',
      input: { questions: [{ question: questionId, multiSelect: true }] },
      suggestions: [],
      questionIds: [questionId],
      answers: new Map(),
      request: { subtype: 'can_use_tool' }
    }
    const answer = 'frontend, backend'

    expect(
      applyClaudePromptAnswer({ prompt, questionId }, encodeClaudeQuestionOptionId('q1', answer))
    ).toMatchObject({
      updatedInput: { answers: { [questionId]: answer } }
    })
  })
})
