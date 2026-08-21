import { Platform } from 'react-native'
import type { ViewStyle } from 'react-native'
import { useMemo, useState } from 'react'
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
  type NativeChatKeyboardDismissMode,
  type NativeChatKeyboardPhase
} from './mobile-native-chat-keyboard-lift'

function keyboardPhase(state: KeyboardState): NativeChatKeyboardPhase {
  'worklet'
  if (state === KeyboardState.OPENING || state === KeyboardState.OPEN) {
    return 'settling'
  }
  return state === KeyboardState.CLOSING ? 'dismissing' : 'unreported'
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
  const [keyboardIsReported, setKeyboardIsReported] = useState(false)
  useAnimatedReaction(
    () => nativeChatKeyboardIsReported(keyboardPhase(keyboard.state.value)),
    (reported, previous) => {
      if (reported !== previous) {
        runOnJS(setKeyboardIsReported)(reported)
      }
    }
  )
  const padStyle = useAnimatedStyle(() => ({
    paddingBottom: resolveNativeChatBottomPad({
      phase: keyboardPhase(keyboard.state.value),
      liveKeyboardHeight: keyboard.height.value,
      committedInset,
      bottomInset
    })
  }))
  return {
    dismissMode: resolveNativeChatKeyboardDismissMode(Platform.OS, keyboardIsReported),
    padStyle
  }
}
