import type { Code, Construct, Effects, State, Token, TokenizeContext } from 'micromark-util-types'

const SIGN = '[+\\-−＋－]?'
const DIGIT = '\\p{Nd}'
const NUMBER_SEPARATOR = "[.,，．'’\\u00a0\\u202f ]"
const NUMBER_BODY = `(?:${DIGIT}+(?:${NUMBER_SEPARATOR}${DIGIT}+)*|[.．]${DIGIT}+)`
const EXPONENT = `(?:[eE]${SIGN}${DIGIT}+)?`
const NUMERIC_LITERAL = `${SIGN}${NUMBER_BODY}${EXPONENT}`
const LEADING_NUMERIC_LITERAL = new RegExp(`^${NUMERIC_LITERAL}`, 'u')
const PURE_NUMERIC_LITERAL = new RegExp(`^${NUMERIC_LITERAL}$`, 'u')
const STRONG_MATH_SYNTAX = /[\\^_={}]/u
const SYMBOLIC_OPERAND = `(?:\\\\[A-Za-z]+|[\\p{L}\\p{Nl}](?:[_^][\\p{L}\\p{Nl}\\p{Nd}{}]+)?)`
const MATH_OPERAND = `(?:${NUMERIC_LITERAL}|${SYMBOLIC_OPERAND})`
const MATH_OPERATOR = '(?:[+\\-−＋－*/<>=,:;，；：]|\\p{Sm}|\\\\[A-Za-z]+|mod|div)'
const NUMERIC_MATH_EXPRESSION = new RegExp(
  `^${NUMERIC_LITERAL}(?:\\s*${MATH_OPERATOR}\\s*${MATH_OPERAND})+$`,
  'u'
)
const CURRENCY_RANGE_SYNTAX = /[→~～〜–—]/u
const PROSE_BOUNDARY = /[\s;:；：,，。！？!?、]/u
const MARKDOWN_LABEL_BOUNDARY = /\](?:\(|\[)/u
const COMPACT_VALUE = /^[^\s$]+$/u
const POTENTIAL_NUMERIC_START = /^[+\-−＋－.．\p{Nd}]$/u

export type CurrencyMathDiagnostics = {
  classifiedCodeUnits: number
  currencyDollars: number
  dollarAttempts: number
  lookaheadCodes: number
}

export function isCurrencyDollarSpan(value: string, closed: boolean): boolean {
  const trimmed = value.trim()
  const numericPrefix = LEADING_NUMERIC_LITERAL.exec(trimmed)?.[0]
  if (numericPrefix === undefined) {
    return false
  }
  if (!closed) {
    return true
  }
  if (PURE_NUMERIC_LITERAL.test(trimmed) || NUMERIC_MATH_EXPRESSION.test(trimmed)) {
    return false
  }

  const suffix = trimmed.slice(numericPrefix.length)
  if (MARKDOWN_LABEL_BOUNDARY.test(suffix)) {
    return true
  }
  if (STRONG_MATH_SYNTAX.test(suffix)) {
    return false
  }
  if (CURRENCY_RANGE_SYNTAX.test(suffix)) {
    return true
  }
  if (!PROSE_BOUNDARY.test(suffix)) {
    return /[.,，．'’\u00a0\u202f ]/u.test(numericPrefix)
  }
  return true
}

function isPotentialNumericStart(code: Code): boolean {
  if (code === null || code < 0) {
    return false
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    return true
  }
  return POTENTIAL_NUMERIC_START.test(String.fromCharCode(code))
}

function previousExitAt(context: TokenizeContext, offset: number): Token | undefined {
  for (let index = context.events.length - 1; index >= 0; index -= 1) {
    const [kind, token] = context.events[index]
    if (kind === 'exit' && token.end.offset === offset) {
      return token
    }
  }
  return undefined
}

function closesEscapedCompactValue(context: TokenizeContext): boolean {
  const data = previousExitAt(context, context.now().offset)
  if (data?.type !== 'data') {
    return false
  }
  const value = context.sliceSerialize(data)
  if (!COMPACT_VALUE.test(value)) {
    return false
  }
  const escape = previousExitAt(context, data.start.offset)
  return escape?.type === 'characterEscape' && context.sliceSerialize(escape).endsWith('\\$')
}

function currencyLookahead(
  context: TokenizeContext,
  diagnostics: CurrencyMathDiagnostics | undefined
): Construct {
  return { partial: true, tokenize }

  function tokenize(effects: Effects, ok: State, nok: State): State {
    let candidate: Token | undefined

    return start

    function start(code: Code): State | undefined {
      if (!isPotentialNumericStart(code)) {
        return nok(code)
      }
      candidate = effects.enter('data')
      return scan(code)
    }

    function scan(code: Code): State | undefined {
      if (code === null || code === 36) {
        effects.exit('data')
        const value = context.sliceSerialize(candidate as Token)
        if (diagnostics !== undefined) {
          diagnostics.classifiedCodeUnits += value.length
        }
        if (code === null) {
          return isCurrencyDollarSpan(value, false) ? ok(code) : nok(code)
        }
        effects.enter('data')
        effects.consume(code)
        effects.exit('data')
        return inspectCloser(value)
      }
      if (diagnostics !== undefined) {
        diagnostics.lookaheadCodes += 1
      }
      effects.consume(code)
      return scan
    }

    function inspectCloser(value: string): State {
      return function afterCloser(code: Code): State | undefined {
        if (diagnostics !== undefined) {
          diagnostics.lookaheadCodes += 1
        }
        return code === 36 || !isCurrencyDollarSpan(value, true) ? nok(code) : ok(code)
      }
    }
  }
}

export function currencyDollarConstruct(diagnostics?: CurrencyMathDiagnostics): Construct {
  return {
    name: 'currencyDollar',
    tokenize(effects, ok, nok) {
      const claimCurrencyDollar: State = (code) => {
        if (diagnostics !== undefined) {
          diagnostics.currencyDollars += 1
        }
        return ok(code)
      }
      return (code) => {
        if (code !== 36) {
          return nok(code)
        }
        if (diagnostics !== undefined) {
          diagnostics.dollarAttempts += 1
        }
        const escapedCloser = closesEscapedCompactValue(this)
        effects.enter('data')
        effects.consume(code)
        effects.exit('data')
        if (escapedCloser) {
          return claimCurrencyDollar
        }
        return effects.check(currencyLookahead(this, diagnostics), claimCurrencyDollar, nok)
      }
    }
  }
}
