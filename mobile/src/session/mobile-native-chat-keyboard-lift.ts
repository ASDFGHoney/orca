export type NativeChatKeyboardDismissMode = 'interactive' | 'on-drag'

/** iOS drags the keyboard down with the finger; Android has no interactive mode,
 *  so there the drag itself commits the hide. */
export function resolveNativeChatKeyboardDismissMode(
  platform: string
): NativeChatKeyboardDismissMode {
  return platform === 'ios' ? 'interactive' : 'on-drag'
}

export type NativeChatBottomPadInput = {
  /** Whether the keyboard observer is publishing a real frame right now. While
   *  it is idle its height reads 0 even with the keyboard up — iOS can restore
   *  a keyboard with no animation for the observer to follow — so only the
   *  route's inset knows the keyboard is there. */
  keyboardFrameIsLive: boolean
  /** Keyboard frame height sampled on the UI thread; tracks an interactive drag
   *  frame by frame. */
  liveKeyboardHeight: number
  /** The route's React-state lift, which stays at its full value until the
   *  interactive gesture commits and `keyboardWillHide` finally fires. */
  committedInset: number
  bottomInset: number
}

/** Bottom padding that keeps the composer glued to the top of the keyboard. */
export function resolveNativeChatBottomPad(input: NativeChatBottomPadInput): number {
  'worklet'
  if (!input.keyboardFrameIsLive) {
    return input.committedInset + input.bottomInset
  }
  // The keyboard frame already spans the home indicator, so it replaces the
  // bottom inset rather than stacking on top of it.
  return Math.max(input.liveKeyboardHeight, input.bottomInset)
}
