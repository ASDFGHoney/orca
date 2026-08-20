import { Platform } from 'react-native'
import type { ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  KeyboardState,
  useAnimatedKeyboard,
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
  return { height: useSharedValue(0), state: useSharedValue<KeyboardState>(KeyboardState.UNKNOWN) }
}

// Why: Reanimated's Android observer takes over the activity's window-insets
// handling, which would fight the app's manual lift. Subscribe on iOS only —
// the only platform with an interactive keyboard to follow anyway.
const useKeyboardFrame = Platform.OS === 'ios' ? useAnimatedKeyboard : useUntrackedKeyboard

/** Keeps the composer glued to the keyboard's top edge, including through an
 *  iOS interactive dismissal — `keyboardWillHide` only fires once that gesture
 *  commits, so the route's `keyboardInset` cannot drive the drag on its own. */
export function useMobileNativeChatKeyboardLift(committedInset: number): {
  dismissMode: NativeChatKeyboardDismissMode
  padStyle: AnimatedStyle<ViewStyle>
} {
  const bottomInset = useSafeAreaInsets().bottom
  const keyboard = useKeyboardFrame()
  const padStyle = useAnimatedStyle(() => ({
    paddingBottom: resolveNativeChatBottomPad({
      keyboardState: keyboard.state.value,
      liveKeyboardHeight: keyboard.height.value,
      committedInset,
      bottomInset
    })
  }))
  return { dismissMode: resolveNativeChatKeyboardDismissMode(Platform.OS), padStyle }
}
