import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import type { Processor } from 'unified'

const NUMERIC_PREFIX =
  /^[+\-−＋－]?(?:(?:\p{Nd}{1,3}(?:[,，]\p{Nd}{3})+|\p{Nd}+)(?:[.．]\p{Nd}+)?|[.．]\p{Nd}+)/u
const PURE_CURRENCY_AMOUNT =
  /^[+\-−＋－]?(?:(?:\p{Nd}{1,3}(?:[,，]\p{Nd}{3})+|\p{Nd}+)(?:[.．]\p{Nd}+)?|[.．]\p{Nd}+)$/u
const RANGE_SEPARATOR = /[+\-−＋－–—→~～〜]$/u
const CURRENCY_RANGE_PREFIX =
  /^\s*[-−－–—→~～〜]\s*[+\-−＋－]?(?:(?:\p{Nd}{1,3}(?:[,，]\p{Nd}{3})+|\p{Nd}+)(?:[.．]\p{Nd}+)?|[.．]\p{Nd}+)/u
const ENGLISH_CURRENCY_RANGE_SUFFIX = /^[+\-−＋－]?\s+to$/iu
const COMPACT_ESCAPED_VALUE = /^[^\s$]+$/u
const CJK_PROSE_AFTER_AMOUNT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const CJK_PROSE_AFTER_PUNCTUATION =
  /[;:；：,，。！？!?、][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const MARKDOWN_PROSE_AFTER_CURRENCY = /`|\]\([^)]*\)/u
const MATH_SIGNAL = /[\\^_={}+]|(?:^|\s)[*/](?:\s|$)/u
const PROSE_AFTER_CLOSER = /[\s,.;:!?，。；：！？、]/u

type MathTextConstruct = Exclude<
  NonNullable<NonNullable<ReturnType<typeof math>['text']>[36]>,
  unknown[]
>
type MathTextTokenizer = MathTextConstruct['tokenize']
type MathTokenizeContext = ThisParameterType<MathTextTokenizer>

function startsNumericPrefix(code: number | null): boolean {
  return code !== null && code >= 0 && /[+\-−＋－.．\p{Nd}]/u.test(String.fromCodePoint(code))
}

function continuesCurrencyAmount(code: number | null): boolean {
  return code !== null && code >= 0 && /[+\-−＋－.．,，\p{Nd}]/u.test(String.fromCodePoint(code))
}

function startsProseAfterCloser(code: number | null): boolean {
  return code === null || code < 0 || PROSE_AFTER_CLOSER.test(String.fromCodePoint(code))
}

function openingClosesEscapedCompactValue(context: MathTokenizeContext): boolean {
  const dataExit = context.events.at(-1)
  if (dataExit?.[0] !== 'exit' || dataExit[1].type !== 'data') {
    return false
  }

  const data = dataExit[1]
  if (data.end.offset !== context.now().offset) {
    return false
  }

  const value = context.sliceSerialize(data)

  for (let index = context.events.length - 2; index >= 0; index -= 1) {
    const [eventType, token] = context.events[index]
    if (token.end.offset < data.start.offset) {
      break
    }
    if (
      eventType === 'exit' &&
      token.type === 'characterEscape' &&
      token.end.offset === data.start.offset
    ) {
      return context.sliceSerialize(token) === '\\$' && COMPACT_ESCAPED_VALUE.test(value)
    }
  }
  return false
}

function isTrailingCurrencyProse(value: string, trimmed: string): boolean {
  if (/^\s/u.test(value) || !/\s$/u.test(value)) {
    return false
  }
  const prefix = NUMERIC_PREFIX.exec(trimmed)?.[0]
  if (prefix === undefined) {
    return false
  }
  let suffix = trimmed.slice(prefix.length)
  const rangePrefix = CURRENCY_RANGE_PREFIX.exec(suffix)?.[0]
  if (rangePrefix !== undefined) {
    suffix = suffix.slice(rangePrefix.length)
  }
  if (suffix.length === 0) {
    return false
  }
  if (ENGLISH_CURRENCY_RANGE_SUFFIX.test(suffix)) {
    return true
  }
  if (MATH_SIGNAL.test(suffix) || /\p{Nd}/u.test(suffix) || /^(?:[*/]\s*)?\p{L}+$/u.test(suffix)) {
    return false
  }
  return !suffix.split(/\s+/u).some((part) => /^\p{L}$/u.test(part))
}

export function isIntentionalInlineMath(value: string, nextCode: number | null): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return false
  }
  const numericPrefix = NUMERIC_PREFIX.exec(trimmed)?.[0]
  if (numericPrefix === undefined) {
    return true
  }
  if (PURE_CURRENCY_AMOUNT.test(trimmed)) {
    return false
  }
  const suffix = trimmed.slice(numericPrefix.length)
  if (CJK_PROSE_AFTER_AMOUNT.test(suffix)) {
    return false
  }
  if (CJK_PROSE_AFTER_PUNCTUATION.test(trimmed) || MARKDOWN_PROSE_AFTER_CURRENCY.test(trimmed)) {
    return false
  }
  if (isTrailingCurrencyProse(value, trimmed)) {
    return false
  }
  if (!startsNumericPrefix(nextCode)) {
    return true
  }
  return !RANGE_SEPARATOR.test(trimmed)
}

function createCurrencyAwareMathExtension(): ReturnType<typeof math> {
  const extension = math()
  const textConstruct = extension.text?.[36]
  if (textConstruct === undefined || Array.isArray(textConstruct)) {
    throw new Error('Expected one micromark math text construct')
  }
  const rejectedCloserOffsets = new WeakMap<MathTokenizeContext, Set<number>>()

  const adjacentCurrencyConstruct: MathTextConstruct = {
    name: 'adjacentCurrencyText',
    previous: textConstruct.previous,
    tokenize(effects, ok, nok) {
      let token: ReturnType<typeof effects.enter> | undefined
      const start = (code: number | null) => {
        if (code !== 36) {
          return nok(code)
        }
        token = effects.enter('data')
        effects.consume(code)
        return inside
      }
      const inside = (code: number | null) => {
        if (code === 36) {
          effects.consume(code)
          effects.exit('data')
          return afterClose
        }
        if (!continuesCurrencyAmount(code)) {
          return nok(code)
        }
        effects.consume(code)
        return inside
      }
      const afterClose = (code: number | null) => {
        if (code !== 36 || token === undefined) {
          return nok(code)
        }
        const raw = this.sliceSerialize(token)
        return PURE_CURRENCY_AMOUNT.test(raw.slice(1, -1)) ? ok(code) : nok(code)
      }
      return start
    }
  }

  const tokenize: MathTextTokenizer = function (effects, ok, nok) {
    const blockedOffsets = rejectedCloserOffsets.get(this)
    if (blockedOffsets?.delete(this.now().offset) === true) {
      return nok
    }
    const closesEscapedCompactValue = openingClosesEscapedCompactValue(this)
    let mathToken: ReturnType<typeof effects.enter> | undefined
    let openingSequence: ReturnType<typeof effects.enter> | undefined
    let closingSequence: ReturnType<typeof effects.enter> | undefined
    const enter: typeof effects.enter = (...args) => {
      const token = effects.enter(...args)
      if (args[0] === 'mathText') {
        mathToken = token
      } else if (args[0] === 'mathTextSequence') {
        if (openingSequence === undefined) {
          openingSequence = token
        } else {
          closingSequence = token
        }
      }
      return token
    }
    const guardedEffects = { ...effects, enter }
    const upstreamContext =
      this.previous === 36
        ? Object.assign(Object.create(this) as MathTokenizeContext, { previous: 0 })
        : this

    return textConstruct.tokenize.call(
      upstreamContext,
      guardedEffects,
      (code) => {
        if (mathToken === undefined || openingSequence === undefined) {
          return nok(code)
        }
        const delimiterWidth = openingSequence.end.offset - openingSequence.start.offset
        if (delimiterWidth > 1) {
          return ok(code)
        }
        if (closesEscapedCompactValue) {
          return nok(code)
        }
        const raw = this.sliceSerialize(mathToken)
        const value = raw.slice(1, -1)
        if (isIntentionalInlineMath(value, code)) {
          return ok(code)
        }
        if (
          closingSequence !== undefined &&
          (PURE_CURRENCY_AMOUNT.test(value.trim()) || startsProseAfterCloser(code))
        ) {
          const offsets = blockedOffsets ?? new Set<number>()
          offsets.add(closingSequence.start.offset)
          rejectedCloserOffsets.set(this, offsets)
        }
        return nok(code)
      },
      nok
    )
  }

  const previous: NonNullable<MathTextConstruct['previous']> = function (code) {
    const lastEvent = this.events.at(-1)
    if (
      code === 36 &&
      lastEvent?.[0] === 'exit' &&
      lastEvent[1].type === 'data' &&
      lastEvent[1].end.offset === this.now().offset
    ) {
      const raw = this.sliceSerialize(lastEvent[1])
      if (raw.startsWith('$') && raw.endsWith('$') && PURE_CURRENCY_AMOUNT.test(raw.slice(1, -1))) {
        return true
      }
    }
    return textConstruct.previous?.call(this, code) ?? true
  }

  extension.text![36] = [adjacentCurrencyConstruct, { ...textConstruct, tokenize, previous }]
  return extension
}

export function remarkCurrencyAwareMath(this: Processor): undefined {
  const data = this.data()
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = [])
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = [])

  micromarkExtensions.push(createCurrencyAwareMathExtension())
  fromMarkdownExtensions.push(mathFromMarkdown())
}
