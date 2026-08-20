import { describe, expect, it } from 'vitest'
import {
  resolveNativeChatBottomPad,
  resolveNativeChatKeyboardDismissMode
} from './mobile-native-chat-keyboard-lift'

const IOS_KEYBOARD_HEIGHT = 336
const BOTTOM_INSET = 34
// The route lifts by the keyboard height minus the home indicator on iOS.
const COMMITTED_INSET = IOS_KEYBOARD_HEIGHT - BOTTOM_INSET

describe('resolveNativeChatKeyboardDismissMode', () => {
  it('follows the finger on iOS once the observer reports frames', () => {
    expect(resolveNativeChatKeyboardDismissMode('ios', true)).toBe('interactive')
  })

  it('will not drag a keyboard it cannot follow', () => {
    expect(resolveNativeChatKeyboardDismissMode('ios', false)).toBe('on-drag')
  })

  it('commits the hide on drag everywhere else', () => {
    expect(resolveNativeChatKeyboardDismissMode('android', true)).toBe('on-drag')
    expect(resolveNativeChatKeyboardDismissMode('web', true)).toBe('on-drag')
  })
})

describe('resolveNativeChatBottomPad', () => {
  it('falls back to the route inset while the keyboard observer is idle', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardFrameIsLive: false,
        liveKeyboardHeight: 0,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })

  it('keeps the composer clear of the home indicator with no keyboard', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardFrameIsLive: false,
        liveKeyboardHeight: 0,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('matches the route inset while the keyboard sits open', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardFrameIsLive: true,
        liveKeyboardHeight: IOS_KEYBOARD_HEIGHT,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })

  it('rides the keyboard down mid-drag while the route inset is still stale', () => {
    // keyboardWillHide has not fired yet, so committedInset still reads full lift.
    expect(
      resolveNativeChatBottomPad({
        keyboardFrameIsLive: true,
        liveKeyboardHeight: 180,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(180)
  })

  it('never lets a part-dragged keyboard pull the composer under the home indicator', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardFrameIsLive: true,
        liveKeyboardHeight: 12,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('rests on the bottom inset once the drag commits', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardFrameIsLive: false,
        liveKeyboardHeight: 0,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('holds the lift when a restored keyboard reports no frame to follow', () => {
    // iOS can put the keyboard back with no animation for the observer to ride
    // (foregrounding with the composer focused), leaving its height at 0 while
    // the route already knows the keyboard is up.
    expect(
      resolveNativeChatBottomPad({
        keyboardFrameIsLive: false,
        liveKeyboardHeight: 0,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })
})
