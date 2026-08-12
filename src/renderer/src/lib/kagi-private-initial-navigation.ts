import { redactKagiSessionToken } from '../../../shared/browser-url'

export type KagiInitialNavigation = {
  modelUrl: string
  navigationUrl: string
}

const pendingNavigations = new Map<string, string>()

export function queueKagiPrivateInitialNavigation(pageId: string, url: string): void {
  if (redactKagiSessionToken(url) === url) {
    throw new Error('Expected a Kagi private-session URL.')
  }
  pendingNavigations.set(pageId, url)
}

export function takeKagiPrivateInitialNavigation(
  pageId: string,
  modelUrl: string
): KagiInitialNavigation {
  const navigationUrl = pendingNavigations.get(pageId) ?? modelUrl
  pendingNavigations.delete(pageId)
  return { modelUrl: redactKagiSessionToken(modelUrl), navigationUrl }
}

export function discardKagiPrivateInitialNavigation(pageId: string): void {
  pendingNavigations.delete(pageId)
}
