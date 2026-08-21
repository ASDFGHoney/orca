import { Platform } from 'react-native'
import type { ViewStyle } from 'react-native'
import { useEffect, useMemo, useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  KeyboardState,
  runOnJS,
  useAnimatedKeyboard,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedKeyboardInfo,
  type AnimatedStyle
} from 'react-native-reanimated'
import {
  resolveNativeChatBottomPad,
  resolveNativeChatKeyboardDismissMode,
  nativeChatKeyboardIsReported,
  nativeChatKeyboardStaysLeaving,
  type NativeChatKeyboardDismissMode,
  type NativeChatKeyboardPhase
} from './mobile-native-chat-keyboard-lift'

function keyboardPhase(state: KeyboardState, isLeaving: boolean): NativeChatKeyboardPhase {
  'worklet'
  if (state === KeyboardState.UNKNOWN || state === KeyboardState.CLOSED) {
    return 'unreported'
  }
  return isLeaving ? 'dismissing' : 'settling'
}

function useUntrackedKeyboard(): AnimatedKeyboardInfo {
  const height = useSharedValue(0)
  const state = useSharedValue<KeyboardState>(KeyboardState.UNKNOWN)
  // Why: useAnimatedStyle takes its dependencies from the updater's closure, so
  // a fresh object each render would restart the UI-thread mapper every render.
  return useMemo(() => ({ height, state }), [height, state])
}

// Why: Reanimated's Android observer takes over the activity's window-insets
// handling, which would fight the app's manual lift. Subscribe on iOS only —
// the only platform with an interactive keyboard to follow anyway.
const useKeyboardFrame = Platform.OS === 'ios' ? useAnimatedKeyboard : useUntrackedKeyboard

/** Keeps the composer glued to the keyboard's top edge, including through an
 *  iOS interactive dismissal — `keyboardWillHide` only fires once that gesture
 *  commits, so the route's `keyboardInset` cannot drive the drag on its own.
 *
 *  `useAnimatedKeyboard` is deprecated in favour of react-native-keyboard-
 *  controller, which is a new native dependency and so a separate decision. */
export function useMobileNativeChatKeyboardLift(committedInset: number): {
  dismissMode: NativeChatKeyboardDismissMode
  padStyle: AnimatedStyle<ViewStyle>
} {
  const bottomInset = useSafeAreaInsets().bottom
  const keyboard = useKeyboardFrame()
  // The dismiss mode is a React prop, so mirror the observer across — derived
  // from the same phase the padding reads, or the two disagree in exactly the
  // state the fallback exists for and the drag strands the composer again.
  // Latched separately from the reported state — see nativeChatKeyboardStaysLeaving.
  const keyboardIsLeaving = useSharedValue(false)
  useAnimatedReaction(
    () => keyboard.state.value,
    (state) => {
      keyboardIsLeaving.value = nativeChatKeyboardStaysLeaving({
        wasLeaving: keyboardIsLeaving.value,
        isClosing: state === KeyboardState.CLOSING,
        hasSettled: state === KeyboardState.OPEN || state === KeyboardState.CLOSED
      })
    }
  )
  const [keyboardIsReported, setKeyboardIsReported] = useState(false)
  useAnimatedReaction(
    () => nativeChatKeyboardIsReported(keyboardPhase(keyboard.state.value, false)),
    (reported, previous) => {
      if (reported !== previous) {
        runOnJS(setKeyboardIsReported)(reported)
      }
    }
  )
  // A keyboard on its way out has already zeroed the route's inset, so hold on
  // to the settled lift — it is the only sane ceiling left for the frame.
  const [lastSettledPad, setLastSettledPad] = useState(0)
  useEffect(() => {
    if (committedInset > 0) {
      setLastSettledPad(committedInset + bottomInset)
    }
  }, [committedInset, bottomInset])
  // Order matters: useAnimatedReaction registers no outputs, so Reanimated has
  // no dependency edge from the latch above to this mapper and falls back to
  // registration order. Declaring padStyle last is what keeps it reading a
  // fresh latch — a reaction added below here would cost a frame per drag.
  const padStyle = useAnimatedStyle(() => ({
    paddingBottom: resolveNativeChatBottomPad({
      phase: keyboardPhase(keyboard.state.value, keyboardIsLeaving.value),
      liveKeyboardHeight: keyboard.height.value,
      committedInset,
      lastSettledPad,
      bottomInset
    })
  }))
  return {
    dismissMode: resolveNativeChatKeyboardDismissMode(Platform.OS, keyboardIsReported),
    padStyle
  }
}
