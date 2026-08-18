import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserClientHostedRemoteSetting } from './BrowserClientHostedRemoteSetting'
import { getBrowserPaneSearchEntries } from './browser-search'
import { getBrowserClientHostedRemoteTitle } from './browser-client-hosted-remote-copy'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('BrowserClientHostedRemoteSetting', () => {
  it('is on when the profile predates the flag and states new-pages-only semantics', () => {
    const markup = renderToStaticMarkup(
      <BrowserClientHostedRemoteSetting settings={{}} updateSettings={vi.fn()} />
    )

    expect(markup).toContain('Host remote browser pages on this device')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('new pages only')
    expect(markup).toContain('never moves a live page')
  })

  it('reads an explicit opt-out as off', () => {
    const markup = renderToStaticMarkup(
      <BrowserClientHostedRemoteSetting
        settings={{ browserClientHostedRemoteEnabled: false }}
        updateSettings={vi.fn()}
      />
    )

    expect(markup).toContain('aria-checked="false"')
  })

  it('writes the inverse of the effective value through the global settings path', () => {
    const updateSettings = vi.fn()
    const enabled = { browserClientHostedRemoteEnabled: true }

    BrowserClientHostedRemoteSetting({
      settings: enabled,
      updateSettings
    }).props.children.props.onChange()
    expect(updateSettings).toHaveBeenLastCalledWith({ browserClientHostedRemoteEnabled: false })

    BrowserClientHostedRemoteSetting({
      settings: { browserClientHostedRemoteEnabled: false },
      updateSettings
    }).props.children.props.onChange()
    expect(updateSettings).toHaveBeenLastCalledWith({ browserClientHostedRemoteEnabled: true })
  })

  it('is findable from settings search by its own title', () => {
    const entry = getBrowserPaneSearchEntries({ isMac: false }).find(
      (candidate) => candidate.title === getBrowserClientHostedRemoteTitle()
    )

    expect(entry?.keywords).toContain('placement')
    expect(entry?.description).toContain('new pages only')
  })
})
