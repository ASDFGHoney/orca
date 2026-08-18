// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
  callRuntimeRpc: mocks.callRuntimeRpc
}))

import { useRemoteBrowserPageInput } from './use-remote-browser-page-input'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'

const VIEWPORT = { width: 800, height: 600 }

function pointerEvent(
  overrides: Partial<{
    clientX: number
    clientY: number
    button: number
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
  }> = {}
): React.PointerEvent<HTMLImageElement> {
  return {
    clientX: 100,
    clientY: 100,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => {},
    ...overrides
  } as unknown as React.PointerEvent<HTMLImageElement>
}

function renderInput(): {
  input: ReturnType<typeof useRemoteBrowserPageInput>
  settle: () => Promise<void>
} {
  const image = document.createElement('img')
  const viewport = document.createElement('div')
  viewport.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height }) as DOMRect
  const pending: Promise<void>[] = []
  const { result } = renderHook(() =>
    useRemoteBrowserPageInput({
      busy: false,
      imageRef: { current: image },
      remoteViewportRef: { current: viewport },
      remoteCssViewportSizeRef: { current: VIEWPORT },
      remoteViewportSizeRef: { current: null },
      frameMetadata: null,
      runtimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' }),
      lifecycle: { tokens: { remotePage: 'page-1' } } as unknown as RemoteBrowserStreamLifecycle,
      runtimeWorktree: 'wt-1',
      enqueueRemoteInput: (operation) => {
        const next = operation()
        pending.push(next)
        return next
      },
      createRemoteOperationToken: () => ({
        tabId: 'tab-1',
        environmentId: 'env-1',
        remotePageId: 'page-1',
        generation: 1
      }),
      isCurrentRemoteOperationToken: () => true,
      closeMissingRemotePage: vi.fn(),
      scheduleRemoteTabInfoRefresh: vi.fn(),
      setPaneNotice: vi.fn()
    })
  )
  return {
    input: result.current,
    settle: async () => {
      await Promise.all(pending)
    }
  }
}

function calledMethods(): string[] {
  return mocks.callRuntimeRpc.mock.calls.map((call) => call[1] as string)
}

describe('remote browser pointer input', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockResolvedValue({})
  })

  it('sends one atomic mouseClick for a press and release at the same point', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 120, clientY: 90 }))
    input.handleRemotePointerUp(pointerEvent({ clientX: 121, clientY: 91 }))
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseClick'])
    expect(mocks.callRuntimeRpc.mock.calls[0][2]).toEqual({
      worktree: 'wt-1',
      page: 'page-1',
      x: 121,
      y: 91,
      button: 'left'
    })
  })

  it('keeps the move/down/move/up chain for a drag', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ clientX: 100, clientY: 100 }))
    input.handleRemotePointerUp(pointerEvent({ clientX: 300, clientY: 260 }))
    await settle()

    expect(calledMethods()).toEqual([
      'browser.mouseMove',
      'browser.mouseDown',
      'browser.mouseMove',
      'browser.mouseUp'
    ])
    expect(mocks.callRuntimeRpc.mock.calls[0][2]).toMatchObject({ x: 100, y: 100 })
    expect(mocks.callRuntimeRpc.mock.calls[2][2]).toMatchObject({ x: 300, y: 260 })
  })

  it('keeps the legacy chain for modified clicks, which carry no modifiers today', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ shiftKey: true }))
    input.handleRemotePointerUp(pointerEvent({ shiftKey: true }))
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown', 'browser.mouseUp'])
  })

  it('falls back to the chain on hosts without mouseClick and stops re-probing them', async () => {
    mocks.callRuntimeRpc.mockImplementation(async (_target, method: string) => {
      if (method === 'browser.mouseClick') {
        throw Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
      }
      return {}
    })
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    input.handleRemotePointerUp(pointerEvent())
    await settle()

    expect(calledMethods()).toEqual([
      'browser.mouseClick',
      'browser.mouseMove',
      'browser.mouseDown',
      'browser.mouseUp'
    ])

    mocks.callRuntimeRpc.mockClear()
    input.handleRemotePointerDown(pointerEvent())
    input.handleRemotePointerUp(pointerEvent())
    await settle()

    expect(calledMethods()).toEqual(['browser.mouseMove', 'browser.mouseDown', 'browser.mouseUp'])
  })

  it('sends nothing for a release whose press was cancelled or never recorded', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent())
    input.handleRemotePointerCancel()
    input.handleRemotePointerUp(pointerEvent())
    await settle()

    expect(calledMethods()).toEqual([])
  })

  it('leaves right-button presses to the context-menu path', async () => {
    const { input, settle } = renderInput()
    input.handleRemotePointerDown(pointerEvent({ button: 2 }))
    input.handleRemotePointerUp(pointerEvent({ button: 2 }))
    await settle()

    expect(calledMethods()).toEqual([])
  })
})
