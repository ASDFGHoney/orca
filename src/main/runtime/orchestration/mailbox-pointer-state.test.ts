import { describe, expect, it } from 'vitest'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

describe('OrchestrationMailboxPointerState', () => {
  it('does not admit newer mail after an unknown prompt is deactivated', () => {
    const state = new OrchestrationMailboxPointerState()
    state.setWatermark('run:1', 1, 'pty-1', 'pane-1')
    expect(state.deactivateWatermark('run:1', 1, 'pty-1')).toBe(true)
    expect(state.releaseSupersededWatermark('run:1', 2)).toBe(false)
  })
})
