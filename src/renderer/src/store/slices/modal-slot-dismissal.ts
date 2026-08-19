/**
 * The app has one modal slot, so opening a modal evicts whatever held it. A modal
 * that owns an unsettled promise (a trust prompt awaiting a decision) hands over
 * this callback so eviction settles it instead of stranding the awaiting caller.
 */
export const MODAL_DISMISSED_KEY = 'onModalDismissed'

export function settleEvictedModalData(evicted: Record<string, unknown>): void {
  const onDismissed = evicted[MODAL_DISMISSED_KEY]
  if (typeof onDismissed === 'function') {
    ;(onDismissed as () => void)()
  }
}
