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
  phase: NativeChatKeyboardPhase
): NativeChatKeyboardDismissMode {
  return platform === 'ios' && phase !== 'unreported' ? 'interactive' : 'on-drag'
}

export type NativeChatBottomPadInput = {
  phase: NativeChatKeyboardPhase
  /** Keyboard frame sampled on the UI thread, as the distance from its top edge
   *  to the bottom of the window; tracks an interactive drag frame by frame. */
  liveKeyboardHeight: number
  /** The route's React-state lift, which stays at its full value until the
   *  interactive gesture commits and `keyboardWillHide` finally fires. */
  committedInset: number
  bottomInset: number
}

/** Bottom padding that keeps the composer glued to the top of the keyboard. */
export function resolveNativeChatBottomPad(input: NativeChatBottomPadInput): number {
  'worklet'
  // The keyboard frame already spans the home indicator, so it replaces the
  // bottom inset rather than stacking on top of it.
  const committedPad = input.committedInset + input.bottomInset
  if (input.phase === 'unreported') {
    return committedPad
  }
  if (input.phase === 'dismissing') {
    return Math.max(input.liveKeyboardHeight, input.bottomInset)
  }
  // Rising or resting, the route's inset is the settled target, so it also caps
  // a frame that is taller than the keyboard: an undocked iPad keyboard floats
  // mid-screen, and its top edge is nowhere near the height of its own panel.
  return Math.max(Math.min(input.liveKeyboardHeight, committedPad), input.bottomInset)
}
