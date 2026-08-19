import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import {
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING
} from './agent-title-core'

describe('agy titles carrying a Gemini model name', () => {
  const AGY_TITLES = [
    '⠋ agy · Gemini 3.7 Flash · high',
    'agy.cmd · Gemini 3.7 Flash · high',
    'Antigravity · Gemini 3.7 Flash',
    'agy · Gemini 3.5 Flash (High)'
  ]

  it.each(AGY_TITLES)('labels %s as Antigravity on both title paths', (title) => {
    expect(getAgentLabel(title)).toBe('Antigravity')
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('antigravity')
  })
})

describe('titles that must keep their existing label', () => {
  it('keeps the recorded Grok pane whose task text names Antigravity', () => {
    const title = 'STA-4011 Linux Antigravity Commit Messages - grok'
    expect(getAgentLabel(title)).toBe('Grok')
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('grok')
  })

  it.each([GEMINI_PERMISSION, GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE])(
    'keeps Gemini glyph %s decisive over an agy token',
    (glyph) => {
      const title = `${glyph} agy · Gemini 3.7 Flash`
      expect(getAgentLabel(title)).toBe('Gemini CLI')
      expect(resolveExplicitTerminalTitleAgentType(title)).toBe('gemini')
    }
  )

  it('still labels a bare gemini token title', () => {
    expect(getAgentLabel('gemini ready')).toBe('Gemini CLI')
    expect(resolveExplicitTerminalTitleAgentType('gemini ready')).toBe('gemini')
  })

  it.each(['agy-workspace · Gemini ready', '/tmp/agy/models · Gemini ready'])(
    'does not treat an agy path fragment as Antigravity in %s',
    (title) => {
      expect(getAgentLabel(title)).toBe('Gemini CLI')
      expect(resolveExplicitTerminalTitleAgentType(title)).toBe('gemini')
    }
  )
})
