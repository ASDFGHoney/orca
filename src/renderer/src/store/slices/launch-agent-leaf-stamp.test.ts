import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { emptyLayoutSnapshot, singlePaneLayoutSnapshot } from './terminal-helpers'
import { stampLaunchAgentLeafIdOnFirstLayout } from './launch-agent-leaf-stamp'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    },
    activeLeafId: LEAF_A,
    expandedLeafId: null
  }
}

describe('stampLaunchAgentLeafIdOnFirstLayout', () => {
  it('pins launch provenance to the first sole leaf', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab({ launchAgent: 'cursor' })],
      tabId: 'tab-1',
      previousLayout: emptyLayoutSnapshot(),
      nextLayout: singlePaneLayoutSnapshot(LEAF_A)
    })

    expect(stamped?.[0]?.launchAgentLeafId).toBe(LEAF_A)
  })

  it('does not overwrite a stamp after the original leaf closes', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab({ launchAgent: 'cursor', launchAgentLeafId: LEAF_A })],
      tabId: 'tab-1',
      previousLayout: splitLayout(),
      nextLayout: singlePaneLayoutSnapshot(LEAF_B)
    })

    expect(stamped).toBeNull()
  })

  it('does not stamp a split as the original leaf', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab({ launchAgent: 'cursor' })],
      tabId: 'tab-1',
      previousLayout: emptyLayoutSnapshot(),
      nextLayout: splitLayout()
    })

    expect(stamped).toBeNull()
  })

  it('does not stamp a tab with no launch identity', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab()],
      tabId: 'tab-1',
      previousLayout: emptyLayoutSnapshot(),
      nextLayout: singlePaneLayoutSnapshot(LEAF_A)
    })

    expect(stamped).toBeNull()
  })
})
