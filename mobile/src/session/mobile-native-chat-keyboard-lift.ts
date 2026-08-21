export type NativeChatKeyboardDismissMode = 'interactive' | 'on-drag'

/** Which source is authoritative for the composer's lift right now. */
export type NativeChatKeyboardPhase =
  /** The keyboard observer is silent, so only the route's inset knows whether a
   *  keyboard is up. It stays silent through a whole session when iOS restores
   *  a keyboard with no animation for the observer to arm itself on. */
  | 'unreported'
  /** Coming up, or resting open: the route's inset is the settled target. */
  | 'settling'
  /** On its way out under the finger: the frame leads and the route's inset
   *  stays stale until the gesture commits. */
  | 'dismissing'

/** iOS drags the keyboard down with the finger; Android has no interactive mode,
 *  so there the drag itself commits the hide.
 *
 *  Following the drag also needs the observer to be publishing frames, so an
 *  unreported keyboard falls back to dismissing on drag — an interactive drag
 *  would otherwise slide the keyboard out from under a composer we have no way
 *  to move, which is the gap this whole change exists to close. */
export function resolveNativeChatKeyboardDismissMode(
  platform: string,
  keyboardIsReported: boolean
): NativeChatKeyboardDismissMode {
  return platform === 'ios' && keyboardIsReported ? 'interactive' : 'on-drag'
}

/** The half of the phase the dismiss mode cares about. Kept separate because the
 *  observer flips between `settling` and `dismissing` on every direction change
 *  of the finger, and only this boolean is worth waking React for. */
export function nativeChatKeyboardIsReported(phase: NativeChatKeyboardPhase): boolean {
  'worklet'
  return phase !== 'unreported'
}

export type NativeChatBottomPadInput = {
  phase: NativeChatKeyboardPhase
  /** Keyboard frame sampled on the UI thread, as the distance from its top edge
   *  to the bottom of the window; tracks an interactive drag frame by frame. */
  liveKeyboardHeight: number
  /** The route's React-state lift, which stays at its full value until the
   *  interactive gesture commits and `keyboardWillHide` finally fires. */
  committedInset: number
  /** The pad last shown for a settled keyboard, which outlives the route's inset
   *  going back to zero. 0 before any keyboard has settled. */
  lastSettledPad: number
  bottomInset: number
}

/** Bottom padding that keeps the composer glued to the top of the keyboard. */
export function resolveNativeChatBottomPad(input: NativeChatBottomPadInput): number {
  'worklet'
  // The route already subtracted the bottom inset from its lift, so add it back.
  const committedPad = input.committedInset + input.bottomInset
  if (input.phase === 'unreported') {
    return committedPad
  }
  // Cap the frame against the tallest lift we have reason to believe in. The
  // observer reports the distance to the keyboard's *top edge*, which for an
  // undocked iPad keyboard floating mid-screen is nowhere near the height of the
  // panel; uncapped it would throw the composer up the screen with it. The
  // route's inset is that ceiling while a keyboard settles, and once one is
  // leaving the inset has already zeroed, so the last settled pad is.
  const ceiling = Math.max(committedPad, input.lastSettledPad)
  // A keyboard frame spans the home indicator already, so it takes the place of
  // the bottom inset rather than stacking on top of it.
  return Math.max(Math.min(input.liveKeyboardHeight, ceiling), input.bottomInset)
}
