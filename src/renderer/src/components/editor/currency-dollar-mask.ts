import type { MarkdownSourceRange, MarkdownTextScope } from './markdown-text-source-ranges'

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
const COMPACT_VALUE = /^[^\s$]+$/u
const FIRST_CURRENCY_MARKER = 0xe000
const LAST_CURRENCY_MARKER = 0xf8ff

export type CurrencyEscape = { maskedOffset: number; line: number }
export type CurrencyMaskDiagnostics = {
  backwardCodeUnits: number
  classifiedCodeUnits: number
  dollarOffsets: number
  sourceCodeUnits: number
}
export type MaskedMarkdown = {
  escapes: CurrencyEscape[]
  marker: string | null
  maskedCount: number
  source: string
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
  if (PURE_NUMERIC_LITERAL.test(trimmed)) {
    return false
  }

  const suffix = trimmed.slice(numericPrefix.length)
  if (STRONG_MATH_SYNTAX.test(suffix) || NUMERIC_MATH_EXPRESSION.test(trimmed)) {
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

function isEscaped(
  source: string,
  index: number,
  diagnostics: CurrencyMaskDiagnostics | undefined
): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (diagnostics !== undefined) {
      diagnostics.backwardCodeUnits += 1
    }
    if (source[cursor] !== '\\') {
      break
    }
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function closesEscapedCompactValue(
  source: string,
  index: number,
  diagnostics: CurrencyMaskDiagnostics | undefined
): boolean {
  let valueStart = index
  while (valueStart > 0) {
    if (diagnostics !== undefined) {
      diagnostics.backwardCodeUnits += 1
    }
    if (!COMPACT_VALUE.test(source[valueStart - 1])) {
      break
    }
    valueStart -= 1
  }
  const escapedOpener = valueStart - 1
  return (
    valueStart < index &&
    source[escapedOpener] === '$' &&
    isEscaped(source, escapedOpener, diagnostics)
  )
}

function findSingleDollarOffsets(
  source: string,
  ranges: MarkdownSourceRange[],
  diagnostics: CurrencyMaskDiagnostics | undefined
): number[] {
  const offsets: number[] = []
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (diagnostics !== undefined) {
        diagnostics.sourceCodeUnits += 1
      }
      if (
        source[index] === '$' &&
        !isEscaped(source, index, diagnostics) &&
        source[index - 1] !== '$' &&
        source[index + 1] !== '$'
      ) {
        offsets.push(index)
      }
    }
  }
  if (diagnostics !== undefined) {
    diagnostics.dollarOffsets += offsets.length
  }
  return offsets
}

function chooseCurrencyMarker(
  source: string,
  decodedCharacters: Set<string>,
  diagnostics: CurrencyMaskDiagnostics | undefined
): string | null {
  if (diagnostics !== undefined) {
    diagnostics.sourceCodeUnits += source.length
  }
  const usedCharacters = new Set(source)
  for (const character of decodedCharacters) {
    usedCharacters.add(character)
  }
  for (let code = FIRST_CURRENCY_MARKER; code <= LAST_CURRENCY_MARKER; code += 1) {
    const marker = String.fromCodePoint(code)
    if (!usedCharacters.has(marker)) {
      return marker
    }
  }
  return null
}

function collectMaskedOffsets(
  source: string,
  scopes: MarkdownTextScope[],
  diagnostics: CurrencyMaskDiagnostics | undefined
): Set<number> {
  const maskedOffsets = new Set<number>()
  for (const ranges of scopes) {
    const offsets = findSingleDollarOffsets(source, ranges, diagnostics)
    const protectedClosers = new Set<number>()
    for (let index = 0; index < offsets.length; index += 1) {
      const offset = offsets[index]
      if (protectedClosers.has(offset)) {
        continue
      }
      if (closesEscapedCompactValue(source, offset, diagnostics)) {
        maskedOffsets.add(offset)
        continue
      }

      const closer = offsets[index + 1]
      const value = source.slice(offset + 1, closer)
      if (diagnostics !== undefined) {
        diagnostics.classifiedCodeUnits += value.length
      }
      if (isCurrencyDollarSpan(value, closer !== undefined)) {
        maskedOffsets.add(offset)
      } else if (closer !== undefined) {
        protectedClosers.add(closer)
      }
    }
  }
  return maskedOffsets
}

function escapeCurrencyDollars(
  source: string,
  offsets: number[],
  diagnostics: CurrencyMaskDiagnostics | undefined
): MaskedMarkdown {
  const chunks: string[] = []
  const escapes: CurrencyEscape[] = []
  let cursor = 0
  let line = 1
  let scanCursor = 0
  for (const [index, offset] of offsets.entries()) {
    for (; scanCursor < offset; scanCursor += 1) {
      if (diagnostics !== undefined) {
        diagnostics.sourceCodeUnits += 1
      }
      if (source[scanCursor] === '\n' || source[scanCursor] === '\r') {
        if (source[scanCursor] === '\r' && source[scanCursor + 1] === '\n') {
          scanCursor += 1
        }
        line += 1
      }
    }
    chunks.push(source.slice(cursor, offset), '\\$')
    escapes.push({ line, maskedOffset: offset + index })
    cursor = offset + 1
  }
  chunks.push(source.slice(cursor))
  return { escapes, marker: null, maskedCount: offsets.length, source: chunks.join('') }
}

export function maskCurrencyDollars(
  source: string,
  scopes: MarkdownTextScope[] = [[{ start: 0, end: source.length }]],
  decodedCharacters = new Set<string>(),
  diagnostics?: CurrencyMaskDiagnostics
): MaskedMarkdown | null {
  const maskedOffsets = collectMaskedOffsets(source, scopes, diagnostics)
  if (maskedOffsets.size === 0) {
    return null
  }
  const offsets = [...maskedOffsets].sort((left, right) => left - right)
  const marker = chooseCurrencyMarker(source, decodedCharacters, diagnostics)
  if (marker === null) {
    return escapeCurrencyDollars(source, offsets, diagnostics)
  }
  const characters = source.split('')
  for (const offset of offsets) {
    characters[offset] = marker
  }
  return {
    escapes: [],
    marker,
    maskedCount: offsets.length,
    source: characters.join('')
  }
}
