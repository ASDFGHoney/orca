import type { MarkdownTokenizer } from '@tiptap/core'
import { InlineMath } from '@tiptap/extension-mathematics'

const baseTokenizer = InlineMath.config.markdownTokenizer as MarkdownTokenizer

// Pandoc: no space after the opening `$`, none before the closer, no digit after it.
const PANDOC_INLINE_MATH = /^\$(?!\s)([^$]*[^\s$])\$(?!\$)(?!\d)/
// Why: `$100$` satisfies Pandoc delimiters but is still a USD amount, not a formula.
const PURE_CURRENCY_AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/

export const RichMarkdownInlineMath = InlineMath.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      const match = PANDOC_INLINE_MATH.exec(src)
      if (!match || PURE_CURRENCY_AMOUNT.test(match[1].trim())) {
        return undefined
      }
      return baseTokenizer.tokenize(src, tokens, lexer)
    }
  }
})
