import { isTextBlock, type NativeChatBlock } from '../../../src/shared/native-chat-types'

/** Concatenate a message's text blocks into a single copyable string. Tool
 *  calls/results and image refs are skipped — Copy is for the agent's prose. */
export function nativeChatMessageText(blocks: readonly NativeChatBlock[]): string {
  return blocks
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n\n')
    .trim()
}

/** Pinch-to-zoom font bounds. Default 1 means no visible change until pinched. */
export const FONT_SCALE_MIN = 0.8
export const FONT_SCALE_MAX = 1.8

export const TEXT_SIZE = 17
/** The user bubble's designed line box. Kept as a ratio of TEXT_SIZE, not a
 *  standalone number, because pinch-to-zoom has to scale the two together. */
export const USER_TEXT_LINE_HEIGHT = TEXT_SIZE + 6

/** Zoomed user-bubble text metrics. Scaling only fontSize against a pinned
 *  lineHeight makes zoomed lines overlap and shears the top line's ascenders off
 *  against the bubble padding - reproduced on device at 1.8x. */
export function scaledUserTextStyle(fontScale: number): {
  fontSize: number
  lineHeight: number
} {
  return { fontSize: TEXT_SIZE * fontScale, lineHeight: USER_TEXT_LINE_HEIGHT * fontScale }
}

/** Clamp a proposed font scale into the supported range. */
export function clampFontScale(scale: number): number {
  if (Number.isNaN(scale)) {
    return 1
  }
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale))
}
