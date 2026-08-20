/** Reanimated reports UNKNOWN until its keyboard observer has seen an event, and
 *  we never subscribe on Android, so it stays UNKNOWN there. */
const KEYBOARD_STATE_UNKNOWN = 0

export type NativeChatKeyboardDismissMode = 'interactive' | 'on-drag'

/** iOS drags the keyboard down with the finger; Android has no interactive mode,
 *  so there the drag itself commits the hide. */
export function resolveNativeChatKeyboardDismissMode(
  platform: string
): NativeChatKeyboardDismissMode {
  return platform === 'ios' ? 'interactive' : 'on-drag'
}

export type NativeChatBottomPadInput = {
  keyboardState: number
  /** Real keyboard frame height sampled on the UI thread — it tracks an
   *  interactive drag frame by frame. */
  liveKeyboardHeight: number
  /** The route's React-state lift, which stays at its full value until the
   *  interactive gesture commits and `keyboardWillHide` finally fires. */
  committedInset: number
  bottomInset: number
}

/** Bottom padding that keeps the composer glued to the top of the keyboard. */
export function resolveNativeChatBottomPad(input: NativeChatBottomPadInput): number {
  'worklet'
  if (input.keyboardState === KEYBOARD_STATE_UNKNOWN) {
    return input.committedInset + input.bottomInset
  }
  // The keyboard frame already spans the home indicator, so it replaces the
  // bottom inset rather than stacking on top of it.
  return Math.max(input.liveKeyboardHeight, input.bottomInset)
}
