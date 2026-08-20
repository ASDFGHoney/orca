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
  type NativeChatKeyboardDismissMode
} from './mobile-native-chat-keyboard-lift'

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
  // The observer stays silent until it has a keyboard frame to report; the
  // dismiss mode has to wait for that, so mirror it into React once.
  const [keyboardFrameSeen, setKeyboardFrameSeen] = useState(false)
  useAnimatedReaction(
    () => keyboard.state.value !== KeyboardState.UNKNOWN,
    (seen, previous) => {
      if (seen && previous !== true) {
        runOnJS(setKeyboardFrameSeen)(true)
      }
    }
  )
  const padStyle = useAnimatedStyle(() => {
    const state = keyboard.state.value
    return {
      paddingBottom: resolveNativeChatBottomPad({
        keyboardFrameIsLive:
          state === KeyboardState.OPENING ||
          state === KeyboardState.OPEN ||
          state === KeyboardState.CLOSING,
        liveKeyboardHeight: keyboard.height.value,
        committedInset,
        bottomInset
      })
    }
  })
  return {
    dismissMode: resolveNativeChatKeyboardDismissMode(Platform.OS, keyboardFrameSeen),
    padStyle
  }
}
