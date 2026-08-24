import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSpinner } from './AgentSpinner'
import { AgentStateDot } from './AgentStateDot'

// Why: pinned to --agent-monitoring in the desktop main.css. Mobile has no CSS
// tokens, so this literal is the only thing keeping the two surfaces in step.
const DESKTOP_MONITORING_COLOR = '#8abeb7'
const DESKTOP_DONE_COLOR = '#10b981'

type MonitoringTestRenderer = {
  readonly root: {
    findAllByType(type: string): { props: Record<string, unknown> }[]
  }
  unmount(): void
}

/** Background colour of the inner dot (the wrapper View is index 0). */
function dotColor(renderer: MonitoringTestRenderer | null): string | undefined {
  const inner = renderer?.root.findAllByType('View')[1]
  const style = inner?.props.style
  const layers = Array.isArray(style) ? style : [style]
  for (const layer of layers) {
    const color = (layer as { backgroundColor?: string } | undefined)?.backgroundColor
    if (typeof color === 'string') {
      return color
    }
  }
  return undefined
}

const { animationLoop, animationTiming, setValue } = vi.hoisted(() => ({
  animationLoop: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  animationTiming: vi.fn(() => ({})),
  setValue: vi.fn()
}))

vi.mock('react-native', () => ({
  Animated: {
    Value: function Value() {
      return { interpolate: vi.fn(() => 'rotation'), setValue }
    },
    View: 'AnimatedView',
    loop: animationLoop,
    timing: animationTiming
  },
  Easing: { linear: 'linear' },
  StyleSheet: { create: <T>(styles: T) => styles },
  View: 'View'
}))

describe('mobile monitoring indicators', () => {
  let renderer: MonitoringTestRenderer | null = null

  beforeEach(() => {
    animationLoop.mockClear()
    animationTiming.mockClear()
    setValue.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('renders a static turquoise dot for a monitoring agent', async () => {
    await act(async () => {
      renderer = create(createElement(AgentStateDot, { state: 'monitoring' }))
    })

    expect(dotColor(renderer)).toBe(DESKTOP_MONITORING_COLOR)
    // Why: the lead turn is over — spinning here is the bug this state exists to fix.
    expect(animationTiming).not.toHaveBeenCalled()
    expect(animationLoop).not.toHaveBeenCalled()
  })

  it('keeps a monitoring agent dot separable from the done dot', async () => {
    await act(async () => {
      renderer = create(createElement(AgentStateDot, { state: 'monitoring' }))
    })

    expect(dotColor(renderer)).not.toBe(DESKTOP_DONE_COLOR)
  })

  it('renders a static turquoise dot for an all-monitoring workspace', async () => {
    await act(async () => {
      renderer = create(
        createElement(AgentSpinner, { status: 'working', workingMode: 'monitoring' })
      )
    })

    expect(dotColor(renderer)).toBe(DESKTOP_MONITORING_COLOR)
    expect(animationTiming).not.toHaveBeenCalled()
    expect(animationLoop).not.toHaveBeenCalled()
  })

  it('keeps the spinner fallback when workingMode is absent', async () => {
    await act(async () => {
      renderer = create(createElement(AgentSpinner, { status: 'working' }))
    })

    expect(animationTiming).toHaveBeenCalledOnce()
    expect(animationLoop).toHaveBeenCalledOnce()
  })
})
