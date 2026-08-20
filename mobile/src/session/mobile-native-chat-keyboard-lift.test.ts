import { describe, expect, it } from 'vitest'
import {
  resolveNativeChatBottomPad,
  resolveNativeChatKeyboardDismissMode
} from './mobile-native-chat-keyboard-lift'

const IOS_KEYBOARD_HEIGHT = 336
const BOTTOM_INSET = 34
// The route lifts by the keyboard height minus the home indicator on iOS.
const COMMITTED_INSET = IOS_KEYBOARD_HEIGHT - BOTTOM_INSET
const OPEN = 2
const CLOSING = 3
const CLOSED = 4
const UNKNOWN = 0

describe('resolveNativeChatKeyboardDismissMode', () => {
  it('follows the finger on iOS', () => {
    expect(resolveNativeChatKeyboardDismissMode('ios')).toBe('interactive')
  })

  it('commits the hide on drag everywhere else', () => {
    expect(resolveNativeChatKeyboardDismissMode('android')).toBe('on-drag')
    expect(resolveNativeChatKeyboardDismissMode('web')).toBe('on-drag')
  })
})

describe('resolveNativeChatBottomPad', () => {
  it('falls back to the route inset until the keyboard observer reports', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardState: UNKNOWN,
        liveKeyboardHeight: 0,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })

  it('keeps the composer clear of the home indicator with no keyboard', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardState: UNKNOWN,
        liveKeyboardHeight: 0,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('matches the route inset while the keyboard sits open', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardState: OPEN,
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
        keyboardState: CLOSING,
        liveKeyboardHeight: 180,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(180)
  })

  it('never lets a part-dragged keyboard pull the composer under the home indicator', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardState: CLOSING,
        liveKeyboardHeight: 12,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('rests on the bottom inset once the drag commits', () => {
    expect(
      resolveNativeChatBottomPad({
        keyboardState: CLOSED,
        liveKeyboardHeight: 0,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })
})
