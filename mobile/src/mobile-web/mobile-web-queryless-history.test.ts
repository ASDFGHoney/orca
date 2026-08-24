import { describe, expect, it, vi } from 'vitest'
import { mobileWebRouteQuery } from './mobile-web-route-query-cache'
import { installMobileWebQuerylessHistory } from './mobile-web-queryless-history'

describe('mobile web queryless history', () => {
  it('keeps same-origin page state in memory and out of the URL', () => {
    const target = historyTarget()

    expect(installMobileWebQuerylessHistory(target)).toBe(true)
    target.history.pushState({ route: 'session' }, '', '/h/host/session/workspace?name=repo')

    expect(target.pushState).toHaveBeenCalledWith(
      { route: 'session' },
      '',
      'https://orca-mobile-web.invalid/h/host/session/workspace'
    )
    expect(mobileWebRouteQuery('/h/host/session/workspace')).toEqual({ name: 'repo' })
  })

  it('clears stale state for a queryless write and leaves foreign URLs to the browser', () => {
    const target = historyTarget()
    installMobileWebQuerylessHistory(target)
    target.history.replaceState(null, '', '/h/host/tasks?taskSource=linear')
    target.history.replaceState(null, '', '/h/host/tasks')
    target.history.pushState(null, '', 'https://example.test/path?secret=value')

    expect(mobileWebRouteQuery('/h/host/tasks')).toEqual({})
    expect(target.pushState).toHaveBeenLastCalledWith(
      null,
      '',
      'https://example.test/path?secret=value'
    )
  })

  it('does not wrap a history twice', () => {
    const target = historyTarget()
    expect(installMobileWebQuerylessHistory(target)).toBe(true)
    expect(installMobileWebQuerylessHistory(target)).toBe(false)
  })
})

function historyTarget() {
  const pushState = vi.fn()
  const replaceState = vi.fn()
  return {
    pushState,
    replaceState,
    history: { pushState, replaceState },
    location: {
      href: 'https://orca-mobile-web.invalid/#shell',
      origin: 'https://orca-mobile-web.invalid'
    }
  }
}
