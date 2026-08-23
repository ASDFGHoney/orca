import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  nativeChatModelAndEffortPillLabel,
  nativeChatModelPillLabel,
  nativeChatSessionChoiceLabel
} from './native-chat-session-option-labels'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

function modelDescriptor(
  valueSource: SessionOptionDescriptor['valueSource'],
  currentValue?: string
): SessionOptionDescriptor {
  return {
    id: 'model',
    label: 'Model',
    valueSource,
    settable: true,
    kind: {
      type: 'select',
      ...(currentValue ? { currentValue } : {}),
      choices: [{ value: 'grok-4.5', label: 'Grok 4.5' }]
    }
  }
}

describe('nativeChatModelPillLabel', () => {
  it('names a model the CLI defaulted to, not the bare category', () => {
    // This is the last step between `defaultModelIsCliDefault` and pixels: withholding
    // `default` here would silently undo the whole load-time default display.
    expect(nativeChatModelPillLabel(modelDescriptor('default', 'grok-4.5'))).toBe('Grok 4.5')
  })

  it('names a model the user picked', () => {
    expect(nativeChatModelPillLabel(modelDescriptor('applied', 'grok-4.5'))).toBe('Grok 4.5')
  })

  it('withholds a value it has no evidence for', () => {
    expect(nativeChatModelPillLabel(modelDescriptor('unknown', 'grok-4.5'))).toBe('Model')
    expect(nativeChatModelPillLabel(modelDescriptor('default'))).toBe('Model')
  })

  it('falls back to the raw id when the list no longer offers it', () => {
    // A discovered list can drop an id the record still tracks; showing the id beats
    // showing "Model" while a real model is running.
    expect(nativeChatModelPillLabel(modelDescriptor('reported', 'grok-build'))).toBe('grok-build')
  })
})

describe('nativeChatModelAndEffortPillLabel', () => {
  it('shows reported model and effort as one current-state label', () => {
    const effort: SessionOptionDescriptor = {
      id: 'effort',
      label: 'Reasoning effort',
      category: 'thought_level',
      valueSource: 'reported',
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'high',
        choices: [{ value: 'high', label: 'High' }]
      }
    }

    expect(nativeChatModelAndEffortPillLabel(modelDescriptor('reported', 'grok-4.5'), effort)).toBe(
      'Grok 4.5 High'
    )
  })

  it('does not imply an unknown effort value', () => {
    const effort: SessionOptionDescriptor = {
      id: 'effort',
      label: 'Reasoning effort',
      category: 'thought_level',
      valueSource: 'unknown',
      settable: true,
      kind: { type: 'select', choices: [{ value: 'high', label: 'High' }] }
    }

    expect(nativeChatModelAndEffortPillLabel(modelDescriptor('reported', 'grok-4.5'), effort)).toBe(
      'Grok 4.5'
    )
  })
})

describe('nativeChatSessionChoiceLabel', () => {
  it('routes ultra through the localized effort label', () => {
    nativeChatSessionChoiceLabel({ value: 'ultra', label: 'Ultra' })

    expect(translate).toHaveBeenCalledWith(
      'components.native-chat.composer.optionValue.ultra',
      'Ultra'
    )
  })
})
