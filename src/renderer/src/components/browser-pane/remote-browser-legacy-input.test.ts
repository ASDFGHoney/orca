// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLegacyRemoteBrowserHistoryExpression,
  buildLegacyRemoteBrowserKeypressExpression,
  buildLegacyRemoteBrowserWheelExpression
} from './remote-browser-legacy-input'

describe('legacy remote browser input', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it.each(['back', 'forward'] as const)(
    'acknowledges legacy %s before changing the page history',
    (direction) => {
      const calls: string[] = []
      vi.spyOn(window.history, direction).mockImplementation(() => calls.push(direction))
      const schedule = vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
        calls.push('scheduled')
        ;(callback as () => void)()
        return 1 as unknown as ReturnType<typeof window.setTimeout>
      })

      const result = window.eval(buildLegacyRemoteBrowserHistoryExpression(direction))

      expect(result).toEqual({ scheduled: direction, url: window.location.href })
      expect(calls).toEqual(['scheduled', direction])
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), 0)
    }
  )

  it('scrolls the nearest scrollable element without raw-input RPCs', () => {
    const scroller = document.createElement('div')
    const child = document.createElement('span')
    scroller.style.overflowY = 'auto'
    scroller.append(child)
    document.body.append(scroller)
    Object.defineProperties(scroller, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 100 }
    })
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy
    document.elementFromPoint = vi.fn(() => child)

    window.eval(buildLegacyRemoteBrowserWheelExpression(10, 20, 0, 120))

    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: 120, behavior: 'instant' })
  })

  it('dispatches a cancellable wheel event before applying fallback scrolling', () => {
    const target = document.createElement('div')
    document.body.append(target)
    document.elementFromPoint = vi.fn(() => target)
    const onWheel = vi.fn((event: WheelEvent) => event.preventDefault())
    target.addEventListener('wheel', onWheel)
    const scrollBy = vi.fn()
    document.documentElement.scrollBy = scrollBy

    window.eval(buildLegacyRemoteBrowserWheelExpression(10, 20, 4, 120))

    expect(onWheel).toHaveBeenCalledOnce()
    expect(onWheel.mock.calls[0]?.[0]).toMatchObject({ deltaX: 4, deltaY: 120 })
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('edits the focused input and emits an input event', () => {
    const input = document.createElement('input')
    input.value = 'ab'
    document.body.append(input)
    input.focus()
    input.setSelectionRange(1, 1)
    const onInput = vi.fn()
    input.addEventListener('input', onInput)

    window.eval(buildLegacyRemoteBrowserKeypressExpression('x')!)

    expect(input.value).toBe('axb')
    expect(onInput).toHaveBeenCalledOnce()
  })

  it('emits printable keypress and honors cancellation before editing', () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    const onKeypress = vi.fn((event: KeyboardEvent) => event.preventDefault())
    input.addEventListener('keypress', onKeypress)

    window.eval(buildLegacyRemoteBrowserKeypressExpression('x')!)

    expect(onKeypress).toHaveBeenCalledOnce()
    expect(input.value).toBe('')
  })

  it('selects contenteditable text for the legacy select-all shortcut', () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    editor.textContent = 'select me'
    document.body.append(editor)
    editor.focus()

    window.eval(buildLegacyRemoteBrowserKeypressExpression('Control+a')!)

    expect(window.getSelection()?.toString()).toBe('select me')
  })

  it('moves focus for Tab and rejects unsupported shortcuts immediately', () => {
    const first = document.createElement('button')
    const second = document.createElement('button')
    first.getClientRects = () => [{ width: 1, height: 1 }] as never
    second.getClientRects = () => [{ width: 1, height: 1 }] as never
    document.body.append(first, second)
    first.focus()

    window.eval(buildLegacyRemoteBrowserKeypressExpression('Tab')!)

    expect(document.activeElement).toBe(second)
    expect(buildLegacyRemoteBrowserKeypressExpression('Control+c')).toBeNull()
  })

  it('respects a page-cancelled keydown and still balances keyup', () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    input.addEventListener('keydown', (event) => event.preventDefault())
    const onKeyup = vi.fn()
    input.addEventListener('keyup', onKeyup)

    window.eval(buildLegacyRemoteBrowserKeypressExpression('x')!)

    expect(input.value).toBe('')
    expect(onKeyup).toHaveBeenCalledOnce()
  })
})
