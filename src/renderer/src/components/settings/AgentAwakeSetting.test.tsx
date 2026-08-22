import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ComputerAwakeStatus } from '../../../../shared/computer-awake-mode'
import { AgentAwakeSetting } from './AgentAwakeSetting'

const platformMock = vi.hoisted(() => ({ platform: 'darwin' as NodeJS.Platform }))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => platformMock.platform
}))

type ReactElementLike = { props: Record<string, unknown>; type?: unknown }

function visit(node: unknown, onElement: (element: ReactElementLike) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      visit(child, onElement)
    }
    return
  }
  if (!node || typeof node !== 'object' || !('props' in node)) {
    return
  }
  const element = node as ReactElementLike
  onElement(element)
  visit((element.props as { children?: unknown }).children, onElement)
}

function findSegmentedControl(node: unknown, ariaLabel: string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (element) => {
    if (element.props.ariaLabel === ariaLabel && typeof element.props.onChange === 'function') {
      found = element
    }
  })
  return found
}

const ENGINE_LABEL = 'Keep awake engine'

function renderSetting(
  awakeStatus?: ComputerAwakeStatus,
  updateSettings = vi.fn()
): { element: React.JSX.Element; updateSettings: ReturnType<typeof vi.fn> } {
  const element = AgentAwakeSetting({
    settings: getDefaultSettings('/tmp'),
    updateSettings,
    awakeStatus
  })
  return { element, updateSettings }
}

describe('AgentAwakeSetting engine picker', () => {
  it('offers the engine choice on macOS and defaults to Caffeinate', () => {
    platformMock.platform = 'darwin'
    const { element } = renderSetting()

    const control = findSegmentedControl(element, ENGINE_LABEL)
    expect(control?.props.value).toBe('caffeinate')
  })

  it('hides the engine choice off macOS', () => {
    platformMock.platform = 'linux'
    const { element } = renderSetting()

    expect(findSegmentedControl(element, ENGINE_LABEL)).toBeNull()
    platformMock.platform = 'darwin'
  })

  it('persists the Amphetamine choice', () => {
    platformMock.platform = 'darwin'
    const { element, updateSettings } = renderSetting({
      mode: 'auto',
      active: false,
      macosEngine: 'caffeinate',
      amphetamineInstalled: true
    })

    const control = findSegmentedControl(element, ENGINE_LABEL)
    expect(control).not.toBeNull()
    const onChange = control?.props.onChange as (engine: string) => void
    onChange('amphetamine')

    expect(updateSettings).toHaveBeenCalledWith({ computerAwakeMacosEngine: 'amphetamine' })
  })

  it('disables Amphetamine and says why when it is not installed', () => {
    platformMock.platform = 'darwin'
    const { element } = renderSetting({
      mode: 'auto',
      active: false,
      macosEngine: 'caffeinate',
      amphetamineInstalled: false
    })

    const control = findSegmentedControl(element, ENGINE_LABEL)
    expect(control).not.toBeNull()
    const options = control?.props.options as { value: string; disabled?: boolean }[]
    expect(options.find((option) => option.value === 'amphetamine')?.disabled).toBe(true)
    expect(options.find((option) => option.value === 'caffeinate')?.disabled).toBeUndefined()
  })

  it('explains the caffeinate fallback when the Automation grant was refused', () => {
    platformMock.platform = 'darwin'
    const { element } = renderSetting({
      mode: 'auto',
      active: true,
      macosEngine: 'amphetamine',
      amphetamineInstalled: true,
      amphetamineUnavailableReason: 'automation-denied'
    })

    let description = ''
    visit(element, (node) => {
      const title = node.props.title
      if (title === ENGINE_LABEL && typeof node.props.description === 'string') {
        description = node.props.description
      }
    })
    expect(description).toContain('Automation')
  })
})
