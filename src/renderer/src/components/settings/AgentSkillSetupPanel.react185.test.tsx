// @vitest-environment happy-dom

/**
 * openSetupTerminal awaits a caller-supplied onBeforeOpenTerminal that does setState-bearing work,
 * so it is a landing site for React's nested-update throw. Its catch was written for setup failures.
 */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { TooltipProvider } from '../ui/tooltip'
import { clearReactErrorBoundaryReportingForTest } from '@/lib/react-error-boundary-reporting'
import {
  flushReactUpdateDepthEscalationsForTest,
  resetReactUpdateDepthEscalationForTest
} from '@/lib/react-update-depth-escalation'

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

const mockStoreState = {
  activeView: 'settings',
  activeModal: 'settings',
  activeTabType: null,
  rightSidebarTab: null,
  activeWorktreeId: null
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: { command: string }) => (
    <div data-testid="inline-command-terminal">{props.command}</div>
  )
}))

const recordRendererError = vi.fn()
const roots: Root[] = []
let container: HTMLDivElement | null = null

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  recordRendererError.mockReset()
  recordRendererError.mockResolvedValue({ ok: true, report: null, deduped: false })
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  Object.assign(globalThis.window, {
    api: {
      cli: { getInstallStatus: vi.fn().mockResolvedValue({ installed: true, inPath: true }) },
      ui: { writeClipboardText: vi.fn() },
      platform: { get: () => ({ platform: 'darwin' }) },
      crashReports: { recordRendererError }
    }
  })
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  container?.remove()
  container = null
})

function panelProps(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'CLI skill',
    description: 'Enables agents to use Orca workflows.',
    command: 'npx skills add orca-cli --global',
    terminalTitle: 'CLI skill setup',
    terminalAriaLabel: 'CLI skill install terminal',
    terminalWorktreeId: 'settings-cli-skill-terminal',
    installed: false,
    loading: false,
    error: null,
    onRecheck: vi.fn(),
    ...overrides
  }
}

async function renderPanel(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <AgentSkillSetupPanel {...panelProps(overrides)} />
      </TooltipProvider>
    )
  })
  await act(async () => {})
  return container
}

async function clickInstall(): Promise<void> {
  const button = Array.from((container ?? document.body).querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Install'
  )
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('AgentSkillSetupPanel open-terminal catch', () => {
  it('escalates a React #185 thrown by onBeforeOpenTerminal', async () => {
    await renderPanel({
      onBeforeOpenTerminal: async () => {
        throw new Error(REACT_185)
      }
    })
    await clickInstall()
    await flushReactUpdateDepthEscalationsForTest()

    expect(recordRendererError).toHaveBeenCalledTimes(1)
    expect(recordRendererError.mock.calls[0]?.[0]?.attribution).toBe('unreliable')
    expect(recordRendererError.mock.calls[0]?.[0]?.boundaryId).toContain('AgentSkillSetupPanel')
  })

  it('escalates a React #185 thrown while applying the pre-install notice', async () => {
    await renderPanel({
      preInstallNotice: <span>Install the Orca CLI first.</span>,
      getPrerequisiteStatus: vi.fn().mockRejectedValue(new Error(REACT_185))
    })
    await flushReactUpdateDepthEscalationsForTest()

    expect(recordRendererError).toHaveBeenCalledTimes(1)
  })

  it('still swallows an ordinary onBeforeOpenTerminal failure without opening the terminal', async () => {
    await renderPanel({
      onBeforeOpenTerminal: async () => {
        throw new Error('runtime unavailable')
      }
    })
    await clickInstall()
    await flushReactUpdateDepthEscalationsForTest()

    expect(container?.querySelector('[data-testid="inline-command-terminal"]')).toBeNull()
    expect(recordRendererError).not.toHaveBeenCalled()
  })
})
