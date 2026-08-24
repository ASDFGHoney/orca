import { rememberMobileWebRouteQuery } from './mobile-web-route-query-cache'

type MobileWebHistoryWriter = (data: unknown, unused: string, url?: string | URL | null) => void

type MobileWebHistoryTarget = {
  history: {
    pushState: MobileWebHistoryWriter
    replaceState: MobileWebHistoryWriter
  }
  location: {
    href: string
    origin: string
  }
}

const installedHistories = new WeakSet<object>()

export function installMobileWebQuerylessHistory(target: MobileWebHistoryTarget = window): boolean {
  const { history, location } = target
  if (installedHistories.has(history)) {
    return false
  }
  history.pushState = querylessHistoryWriter(history, history.pushState, location)
  history.replaceState = querylessHistoryWriter(history, history.replaceState, location)
  installedHistories.add(history)
  return true
}

function querylessHistoryWriter(
  history: MobileWebHistoryTarget['history'],
  writer: MobileWebHistoryWriter,
  location: MobileWebHistoryTarget['location']
): MobileWebHistoryWriter {
  return (data, unused, url) => {
    writer.call(history, data, unused, querylessHistoryUrl(url, location))
  }
}

function querylessHistoryUrl(
  value: string | URL | null | undefined,
  location: MobileWebHistoryTarget['location']
): string | URL | null | undefined {
  if (value == null) {
    return value
  }
  try {
    const candidate = new URL(String(value), location.href)
    if (candidate.origin !== location.origin) {
      return value
    }
    rememberMobileWebRouteQuery(candidate.pathname, candidate.searchParams)
    candidate.search = ''
    return candidate.href
  } catch {
    return value
  }
}
