import { describe, expect, it } from 'vitest'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  NATIVE_CHAT_PAGE,
  nextNativeChatLimit
} from './native-chat-pagination'

describe('nextNativeChatLimit', () => {
  it('grows the limit by one page', () => {
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE
    )
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + 2 * NATIVE_CHAT_PAGE
    )
  })
})

describe('hasMoreNativeChatHistory', () => {
  it('reports more when the read filled the requested window', () => {
    expect(hasMoreNativeChatHistory(300, 300)).toBe(true)
    expect(hasMoreNativeChatHistory(301, 300)).toBe(true)
  })

  it('reports done when the read returned fewer than requested (head reached)', () => {
    expect(hasMoreNativeChatHistory(120, 300)).toBe(false)
    expect(hasMoreNativeChatHistory(0, 300)).toBe(false)
  })

  // The count inference cannot tell "the window is exactly full" from "there is
  // more behind it". That was harmless while this only drove a load-earlier
  // affordance, but it now also decides whether a head turn's `[Image #n]`
  // markers are read as the user's own words, so the host's exact answer wins.
  it('prefers the host’s reported answer over the count inference', () => {
    expect(hasMoreNativeChatHistory(300, 300, false)).toBe(false)
    expect(hasMoreNativeChatHistory(120, 300, true)).toBe(true)
  })

  it('falls back to the count when an older host reports nothing', () => {
    expect(hasMoreNativeChatHistory(300, 300, undefined)).toBe(true)
    expect(hasMoreNativeChatHistory(120, 300, undefined)).toBe(false)
  })
})
