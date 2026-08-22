import { describe, expect, it, vi } from 'vitest'
import { AMPHETAMINE_APP_STORE_URL, AwakeEnginePicker } from './AwakeEnginePicker'
import type { ComputerAwakeStatus } from '../../../../shared/computer-awake-mode'

type ReactElementLike = { props: Record<string, unknown> }

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

function findOption(node: unknown, label: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (element) => {
    if (element.props.label === label) {
      found = element
    }
  })
  if (!found) {
    throw new Error(`no engine option labelled ${label}`)
  }
  return found
}

function render(status: Partial<ComputerAwakeStatus>, onChange = vi.fn()) {
  const element = AwakeEnginePicker({
    engine: 'caffeinate',
    status: { mode: 'auto', active: false, ...status },
    onChange
  })
  // The options are rendered through a helper component, so read its props.
  const options = (element.props as { children: unknown }).children
  return { options, onChange }
}

describe('AwakeEnginePicker', () => {
  it('selects Amphetamine when it is installed', () => {
    const { options, onChange } = render({ amphetamineInstalled: true })

    const amphetamine = findOption(options, 'Amphetamine')
    expect(amphetamine.props.unavailable).toBeFalsy()
    ;(amphetamine.props.onSelect as () => void)()

    expect(onChange).toHaveBeenCalledWith('amphetamine')
  })

  it('sends an uninstalled user to the App Store instead of selecting a dead engine', () => {
    const openUrl = vi.fn()
    vi.stubGlobal('window', { api: { shell: { openUrl } } })
    const { options, onChange } = render({ amphetamineInstalled: false })

    const amphetamine = findOption(options, 'Amphetamine')
    expect(amphetamine.props.unavailable).toBe(true)
    expect(amphetamine.props.hint).toContain('Mac App Store')
    ;(amphetamine.props.onSelect as () => void)()

    expect(onChange).not.toHaveBeenCalled()
    expect(openUrl).toHaveBeenCalledWith(AMPHETAMINE_APP_STORE_URL)
    vi.unstubAllGlobals()
  })

  it('explains what Amphetamine adds when it is missing', () => {
    const { options } = render({ amphetamineInstalled: false })

    expect(findOption(options, 'Amphetamine').props.body).toContain('lid shut')
  })

  it('promises not to touch a session the user started', () => {
    const { options } = render({ amphetamineInstalled: true })

    expect(findOption(options, 'Amphetamine').props.hint).toContain('never replaces or ends')
  })

  it('names the caffeinate fallback when the Automation grant was refused', () => {
    const { options } = render({
      amphetamineInstalled: true,
      amphetamineUnavailableReason: 'automation-denied'
    })

    const hint = findOption(options, 'Amphetamine').props.hint as string
    expect(hint).toContain('Automation')
    expect(hint).toContain('Caffeinate')
  })

  it('describes caffeinate as needing no install', () => {
    const { options } = render({})

    expect(findOption(options, 'Caffeinate').props.body).toContain('Nothing to install')
  })
})
