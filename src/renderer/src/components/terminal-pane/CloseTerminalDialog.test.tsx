// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CloseTerminalDialog from './CloseTerminalDialog'

const mountedRoots: Root[] = []

async function renderDialog(props: {
  copyKind?: 'command' | 'agent'
  busyTabLabels?: readonly string[]
  onConfirm: (dontAskAgain: boolean) => void
  onCancel?: () => void
}): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(
      <CloseTerminalDialog
        open
        copyKind={props.copyKind}
        {...(props.busyTabLabels ? { busyTabLabels: props.busyTabLabels } : {})}
        onCancel={props.onCancel ?? vi.fn()}
        onConfirm={props.onConfirm}
      />
    )
  })
}

function clickButton(label: string): void {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  button.click()
}

describe('CloseTerminalDialog', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('renders running command copy and confirms without skipping by default', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'command', onConfirm })

    expect(document.body.textContent).toContain('Stop running command?')
    expect(document.body.textContent).toContain(
      'Closing this terminal will stop the command running inside it.'
    )

    await act(async () => {
      clickButton('Stop and Close')
    })

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('renders agent copy and passes the skip preference when checked', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'agent', onConfirm })

    expect(document.body.textContent).toContain('Stop this agent?')
    expect(document.body.textContent).toContain(
      "Closing this terminal will stop the agent's current work."
    )

    const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox?.click()
    })
    await act(async () => {
      clickButton('Stop Agent')
    })

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('counts and names every busy tab for a bulk close', async () => {
    const onConfirm = vi.fn()

    await renderDialog({
      copyKind: 'command',
      busyTabLabels: ['npm run dev', 'pytest', 'tail -f log'],
      onConfirm
    })

    expect(document.body.textContent).toContain('Stop 3 running commands?')
    expect(document.body.textContent).toContain(
      'Closing these tabs will stop the commands running inside them.'
    )
    for (const label of ['npm run dev', 'pytest', 'tail -f log']) {
      expect(document.body.textContent).toContain(label)
    }

    await act(async () => {
      clickButton('Stop and Close')
    })

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('caps the named tabs and counts the remainder', async () => {
    await renderDialog({
      busyTabLabels: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
      onConfirm: vi.fn()
    })

    expect(document.body.textContent).toContain('Stop 7 running commands?')
    expect(document.body.textContent).toContain('five')
    expect(document.body.textContent).not.toContain('six')
    expect(document.body.textContent).toContain('+2 more')
  })

  it('keeps the single-tab copy when only one tab in the bulk set is busy', async () => {
    await renderDialog({ copyKind: 'agent', busyTabLabels: ['claude'], onConfirm: vi.fn() })

    expect(document.body.textContent).toContain('Stop this agent?')
    expect(document.body.textContent).not.toContain('Stop 1 running')
  })

  it('resets the skip preference when the dialog closes and reopens', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)
    const render = async (open: boolean): Promise<void> => {
      await act(async () => {
        root.render(<CloseTerminalDialog open={open} onCancel={onCancel} onConfirm={onConfirm} />)
      })
    }

    await render(true)
    const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
    await act(async () => {
      checkbox?.click()
    })
    expect(checkbox?.getAttribute('aria-checked')).toBe('true')

    await render(false)
    await render(true)

    expect(document.body.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe(
      'false'
    )
  })
})
