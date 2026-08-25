import { describe, expect, it } from 'vitest'
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  scaledUserTextStyle,
  TEXT_SIZE,
  USER_TEXT_LINE_HEIGHT
} from './mobile-native-chat-message-text'

// Reproduced on an iPhone 17 Pro sim at fontScale 1.8: the user bubble pinned
// lineHeight at 23 while pinch-to-zoom scaled fontSize to 30.6, so the lines
// overlapped and the top line's ascenders were sheared off against the bubble
// padding. Text taller than its own line box is the whole defect.
describe('scaledUserTextStyle', () => {
  const SCALES = [FONT_SCALE_MIN, 1, 1.2, 1.4, 1.6, FONT_SCALE_MAX]

  it.each(SCALES)('keeps the line box at least as tall as the glyphs at %sx', (scale) => {
    const { fontSize, lineHeight } = scaledUserTextStyle(scale)
    expect(lineHeight).toBeGreaterThanOrEqual(fontSize)
  })

  it.each(SCALES)('holds the designed line-height ratio at %sx', (scale) => {
    const { fontSize, lineHeight } = scaledUserTextStyle(scale)
    expect(lineHeight / fontSize).toBeCloseTo(USER_TEXT_LINE_HEIGHT / TEXT_SIZE, 10)
  })

  it('leaves the unzoomed metrics exactly as designed', () => {
    expect(scaledUserTextStyle(1)).toEqual({
      fontSize: TEXT_SIZE,
      lineHeight: USER_TEXT_LINE_HEIGHT
    })
  })
})
