// Pure pagination math for the native-chat read window. The renderer reads the
// transcript tail with a `limit`; when the user scrolls to the top it raises the
// limit by a page to load older history. Kept pure (no React/IO) so the limit
// growth and the "is there more?" decision are unit-testable.

// First page mirrors the desktop default window (300 most-recent turns) so the
// initial paint matches the prior behavior; each load-earlier grows by a page.
export const NATIVE_CHAT_INITIAL_LIMIT = 300
export const NATIVE_CHAT_PAGE = 200

/** The limit to request for the next older page. */
export function nextNativeChatLimit(currentLimit: number): number {
  return currentLimit + NATIVE_CHAT_PAGE
}

/**
 * Whether an older page may still exist.
 *
 * `reported` is the host's own answer, which is exact — it reads one turn past
 * the limit to decide. Prefer it whenever it is present; an older remote host
 * omits it, and only then do we infer from the count.
 *
 * The inference is deliberately conservative and NOT exact: a transcript whose
 * length is exactly the requested limit fills the window without anything
 * behind it, and still reports true. That is safe for the "load earlier"
 * affordance (one wasted read) but not for anything that changes what a message
 * says, so callers doing the latter should rely on the reported value.
 */
export function hasMoreNativeChatHistory(
  returnedCount: number,
  requestedLimit: number,
  reported?: boolean
): boolean {
  return reported ?? returnedCount >= requestedLimit
}
