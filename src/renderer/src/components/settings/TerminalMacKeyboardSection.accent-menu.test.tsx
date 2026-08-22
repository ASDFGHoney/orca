// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { TerminalMacKeyboardSection } from './TerminalMacKeyboardSection'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: function SearchableSetting({ children }: { children?: ReactNode }) {
    return children ?? null
  }
}))

vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useDetectedOptionAsAlt: () => 'us'
}))

describe('TerminalMacKeyboardSection accent menu', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  function render(showAccentMenuSetting: boolean): void {
    act(() =>
      root.render(
        <TerminalMacKeyboardSection
          settings={getDefaultSettings('/tmp') as GlobalSettings}
          updateSettings={vi.fn()}
          showAccentMenuSetting={showAccentMenuSetting}
        />
      )
    )
  }

  it('offers the accent menu on a desktop Mac', () => {
    render(true)
    expect(container.textContent).toContain('Character Accent Menu')
  })

  it('hides it where no local app can write the macOS preference', () => {
    render(false)
    expect(container.textContent).not.toContain('Character Accent Menu')
    // Why assert a sibling stayed: the gate must hide one control, not the whole section.
    expect(container.textContent).toContain('Option as Alt')
  })
})
