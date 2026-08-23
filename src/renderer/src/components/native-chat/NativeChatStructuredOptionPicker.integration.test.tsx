// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({ call: vi.fn(), operationId: vi.fn(() => 'operation-1') }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items: [],
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: mocks.operationId,
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { useStructuredAgentSession } from './use-structured-agent-session'

const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}
const LOCAL_TARGET = { kind: 'local' } as const

function StructuredOptionPickerHarness(): React.JSX.Element {
  const controller = useStructuredAgentSession({
    sessionId: 'session-1',
    target: LOCAL_TARGET,
    agent: 'codex'
  })
  return (
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={controller.optionSurface}
        snapshot={controller.optionSnapshot}
        isWorking={false}
      />
    </TooltipProvider>
  )
}

describe('structured native-chat option picker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.operationId.mockReturnValue('operation-1')
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.options') {
        return Promise.resolve(OPTIONS)
      }
      if (method === 'agentSession.setOption') {
        return Promise.resolve({
          ok: true,
          value: {
            key: 'model',
            value: 'gpt-fast',
            options: { model: 'gpt-fast', effort: 'low' }
          }
        })
      }
      return Promise.resolve(null)
    })
  })

  it('applies a model through the structured RPC surface and reconciles effort inline', async () => {
    const user = userEvent.setup()
    render(<StructuredOptionPickerHarness />)
    const trigger = await screen.findByRole('button', {
      name: 'Model · Effort GPT Live Medium'
    })

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitemradio', { name: 'GPT Fast' }))

    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        { kind: 'local' },
        'agentSession.setOption',
        expect.objectContaining({ key: 'model', value: 'gpt-fast' })
      )
    )
    expect(
      await screen.findByRole('button', { name: 'Model · Effort GPT Fast Low' })
    ).not.toBeNull()
  })
})
