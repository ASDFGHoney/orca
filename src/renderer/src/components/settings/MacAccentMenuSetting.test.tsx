// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MacAccentMenuSetting } from './MacAccentMenuSetting'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: function SearchableSetting({ children }: { children?: ReactNode }) {
    return children ?? null
  }
}))

const RESTART_NOTICE = 'Restart Orca to apply the accent menu change.'

describe('MacAccentMenuSetting', () => {
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

  function toggle(): HTMLElement {
    const control = container.querySelector('[role="switch"]')
    expect(control).not.toBeNull()
    return control as HTMLElement
  }

  function render(
    macAccentMenuEnabled: boolean | undefined,
    updateSettings = vi.fn()
  ): typeof updateSettings {
    act(() =>
      root.render(
        <MacAccentMenuSetting settings={{ macAccentMenuEnabled }} updateSettings={updateSettings} />
      )
    )
    return updateSettings
  }

  it('reads as off until the user opts into the accent menu', () => {
    // Why: undefined is "never chosen", and the shipped behaviour for that is key repeat.
    render(undefined)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('persists the accent menu choice in both directions', () => {
    const enable = render(undefined)
    act(() => toggle().click())
    expect(enable).toHaveBeenCalledWith({ macAccentMenuEnabled: true })

    const disable = render(true, vi.fn())
    act(() => toggle().click())
    expect(disable).toHaveBeenCalledWith({ macAccentMenuEnabled: false })
  })

  it('asks for a restart only once the value moves', () => {
    // Why: AppKit reads the preference as the process starts, so the change cannot land until then
    // — a toggle with no notice looks broken.
    render(undefined)
    expect(container.textContent).not.toContain(RESTART_NOTICE)

    act(() =>
      root.render(
        <MacAccentMenuSetting settings={{ macAccentMenuEnabled: true }} updateSettings={vi.fn()} />
      )
    )
    expect(container.textContent).toContain(RESTART_NOTICE)
  })

  it('shows no restart notice for a value that was already set on arrival', () => {
    render(true)
    expect(container.textContent).not.toContain(RESTART_NOTICE)
  })
})
