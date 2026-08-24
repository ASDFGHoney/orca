import { BackHandler } from 'react-native'

type MobileWebBackHandlerCallback = () => boolean | null | undefined

type MobileWebBackHandlerTarget = {
  addEventListener(
    eventName: 'hardwareBackPress',
    handler: MobileWebBackHandlerCallback
  ): { remove(): void }
  removeEventListener?: (
    eventName: 'hardwareBackPress',
    handler: MobileWebBackHandlerCallback
  ) => void
}

type MobileWebNavigationTarget = {
  history: History
  location: Pick<Location, 'href'>
  addEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void
}

const HISTORY_INDEX_KEY = '__orcaMobileWebBackIndex'
const PROGRAMMATIC_TRAVERSAL_TIMEOUT_MS = 5_000
const installedHistories = new WeakMap<object, () => boolean>()

export function installMobileWebBackNavigationAdapter(
  backHandler: MobileWebBackHandlerTarget = BackHandler,
  target: MobileWebNavigationTarget = window
): boolean {
  const { history } = target
  if (installedHistories.has(history)) {
    return false
  }

  const handlers: MobileWebBackHandlerCallback[] = []
  const originalPushState = history.pushState.bind(history)
  const originalReplaceState = history.replaceState.bind(history)
  const originalGo = history.go.bind(history)
  const originalBack = history.back.bind(history)
  const originalForward = history.forward.bind(history)
  let currentIndex = historyIndex(history.state) ?? 0
  let maximumIndex = currentIndex
  let expectedProgrammaticIndex: number | null = null
  let programmaticReset: ReturnType<typeof setTimeout> | undefined
  let restoringFromIndex: number | null = null

  originalReplaceState(indexedHistoryState(history.state, currentIndex), '', undefined)

  const markProgrammatic = (targetIndex: number): void => {
    expectedProgrammaticIndex = targetIndex
    clearTimeout(programmaticReset)
    programmaticReset = setTimeout(() => {
      expectedProgrammaticIndex = null
    }, PROGRAMMATIC_TRAVERSAL_TIMEOUT_MS)
  }
  history.pushState = (data, unused, url) => {
    currentIndex += 1
    maximumIndex = currentIndex
    originalPushState(indexedHistoryState(data, currentIndex), unused, url)
  }
  history.replaceState = (data, unused, url) => {
    originalReplaceState(indexedHistoryState(data, currentIndex), unused, url)
  }
  history.go = (delta = 0) => {
    const targetIndex = Math.max(0, Math.min(maximumIndex, currentIndex + delta))
    if (targetIndex !== currentIndex) {
      markProgrammatic(targetIndex)
    }
    originalGo(delta)
  }
  history.back = () => {
    if (currentIndex > 0) {
      markProgrammatic(currentIndex - 1)
    }
    originalBack()
  }
  history.forward = () => {
    if (currentIndex < maximumIndex) {
      markProgrammatic(currentIndex + 1)
    }
    originalForward()
  }

  backHandler.addEventListener = (_eventName, handler) => {
    handlers.push(handler)
    let active = true
    return {
      remove() {
        if (!active) {
          return
        }
        active = false
        removeBackHandler(handlers, handler)
      }
    }
  }
  backHandler.removeEventListener = (_eventName, handler) => {
    removeBackHandler(handlers, handler)
  }

  target.addEventListener('popstate', (event) => {
    const nextIndex = historyIndex(event.state)
    if (nextIndex === null) {
      return
    }
    if (restoringFromIndex !== null) {
      event.stopImmediatePropagation()
      restoringFromIndex = null
      currentIndex = nextIndex
      if (!dispatchBackHandlers(handlers)) {
        history.back()
      }
      return
    }

    const direction = Math.sign(nextIndex - currentIndex)
    if (nextIndex === expectedProgrammaticIndex) {
      expectedProgrammaticIndex = null
      clearTimeout(programmaticReset)
      currentIndex = nextIndex
      return
    }
    if (direction >= 0 || handlers.length === 0) {
      currentIndex = nextIndex
      return
    }

    event.stopImmediatePropagation()
    restoringFromIndex = nextIndex
    originalGo(currentIndex - nextIndex)
  })
  installedHistories.set(history, () => {
    if (dispatchBackHandlers(handlers)) {
      return true
    }
    if (currentIndex === 0) {
      return false
    }
    history.back()
    return true
  })
  return true
}

export function dispatchMobileWebBackNavigation(
  target: MobileWebNavigationTarget = window
): boolean {
  return installedHistories.get(target.history)?.() === true
}

function dispatchBackHandlers(handlers: MobileWebBackHandlerCallback[]): boolean {
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    const handler = handlers[index]
    if (!handler) {
      continue
    }
    try {
      if (handler() === true) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

function removeBackHandler(
  handlers: MobileWebBackHandlerCallback[],
  target: MobileWebBackHandlerCallback
): void {
  const index = handlers.lastIndexOf(target)
  if (index !== -1) {
    handlers.splice(index, 1)
  }
}

function indexedHistoryState(state: unknown, index: number): Record<string, unknown> {
  return isRecord(state) ? { ...state, [HISTORY_INDEX_KEY]: index } : { [HISTORY_INDEX_KEY]: index }
}

function historyIndex(state: unknown): number | null {
  if (!isRecord(state)) {
    return null
  }
  const value = state[HISTORY_INDEX_KEY]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
