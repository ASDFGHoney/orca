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
    expect(resolveNativeChatKeyboardDismissMode('ios', 'settling')).toBe('interactive')
  })

  it('will not drag a keyboard it cannot follow', () => {
    expect(resolveNativeChatKeyboardDismissMode('ios', 'unreported')).toBe('on-drag')
  })

  it('commits the hide on drag everywhere else', () => {
    expect(resolveNativeChatKeyboardDismissMode('android', 'settling')).toBe('on-drag')
    expect(resolveNativeChatKeyboardDismissMode('web', 'settling')).toBe('on-drag')
  })
})

describe('resolveNativeChatBottomPad', () => {
  it('falls back to the route inset while the keyboard observer is idle', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'unreported',
        liveKeyboardHeight: 0,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })

  it('keeps the composer clear of the home indicator with no keyboard', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'unreported',
        liveKeyboardHeight: 0,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('matches the route inset while the keyboard sits open', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'settling',
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
        phase: 'dismissing',
        liveKeyboardHeight: 180,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(180)
  })

  it('never lets a part-dragged keyboard pull the composer under the home indicator', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'dismissing',
        liveKeyboardHeight: 12,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(BOTTOM_INSET)
  })

  it('rests on the bottom inset once the drag commits', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'unreported',
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
        phase: 'unreported',
        liveKeyboardHeight: 0,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(IOS_KEYBOARD_HEIGHT)
  })
})

describe('resolveNativeChatBottomPad on an undocked keyboard', () => {
  // An iPad floating keyboard sits mid-screen: the observer reports the distance
  // from its top edge to the bottom of the window, which dwarfs its own panel.
  const FLOATING_TOP_EDGE = 900

  it('does not shove the composer up to a floating keyboard top edge', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'settling',
        liveKeyboardHeight: FLOATING_TOP_EDGE,
        committedInset: 260,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(260 + BOTTOM_INSET)
  })

  it('still lets a committed keyboard ride down past the route inset', () => {
    // Dismissing is the one phase where the frame must be allowed to lead: the
    // route has already zeroed its inset while the keyboard is still on screen.
    expect(
      resolveNativeChatBottomPad({
        phase: 'dismissing',
        liveKeyboardHeight: 200,
        committedInset: 0,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(200)
  })

  it('rides the opening keyboard up without overshooting its target', () => {
    expect(
      resolveNativeChatBottomPad({
        phase: 'settling',
        liveKeyboardHeight: 90,
        committedInset: COMMITTED_INSET,
        bottomInset: BOTTOM_INSET
      })
    ).toBe(90)
  })
})
