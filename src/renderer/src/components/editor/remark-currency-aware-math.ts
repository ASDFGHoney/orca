import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import type { Processor } from 'unified'

const SIGN = '[+\\-−＋－]?'
const DIGIT = '\\p{Nd}'
const NUMBER_SEPARATOR = "[.,，．'’\\u00a0\\u202f ]"
const NUMBER_BODY = `(?:${DIGIT}+(?:${NUMBER_SEPARATOR}${DIGIT}+)*|[.．]${DIGIT}+)`
const EXPONENT = `(?:[eE]${SIGN}${DIGIT}+)?`
const NUMERIC_LITERAL = `${SIGN}${NUMBER_BODY}${EXPONENT}`
const LEADING_NUMERIC_LITERAL = new RegExp(`^${NUMERIC_LITERAL}`, 'u')
const PURE_NUMERIC_LITERAL = new RegExp(`^${NUMERIC_LITERAL}$`, 'u')
const STRONG_MATH_SYNTAX = /[\\^_={}]/u
const NUMERIC_BINARY_EXPRESSION = new RegExp(
  `^\\s*(?:[+\\-−＋－*/<>→~～〜–—]|\\p{L}+)\\s*${NUMERIC_LITERAL}\\s*$`,
  'u'
)
const SYMBOLIC_BINARY_EXPRESSION =
  /^\s*[+\-−＋－*/<>]\s*[\p{L}\p{Nl}](?:[_^][\p{L}\p{Nl}\p{Nd}{}]+)?\s*$/u
const CURRENCY_RANGE_SYNTAX = /[→~～〜–—]/u
const PROSE_BOUNDARY = /[\s;:；：,，。！？!?、]/u
const COMPACT_VALUE = /^[^\s$]+$/u
const FIRST_CURRENCY_MARKER = 0xe000
const LAST_CURRENCY_MARKER = 0xf8ff

type MaskedMarkdown = { marker: string; source: string }
type SourceRange = { end: number; start: number }

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
  if (
    STRONG_MATH_SYNTAX.test(suffix) ||
    NUMERIC_BINARY_EXPRESSION.test(suffix) ||
    SYMBOLIC_BINARY_EXPRESSION.test(suffix)
  ) {
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

function isEscaped(source: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function closesEscapedCompactValue(source: string, index: number): boolean {
  let valueStart = index
  while (valueStart > 0 && COMPACT_VALUE.test(source[valueStart - 1])) {
    valueStart -= 1
  }
  const escapedOpener = valueStart - 1
  return valueStart < index && source[escapedOpener] === '$' && isEscaped(source, escapedOpener)
}

function findBacktickCodeRanges(source: string): SourceRange[] {
  const runs: (SourceRange & { size: number })[] = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '`') {
      continue
    }
    if (isEscaped(source, index)) {
      continue
    }
    const start = index
    while (source[index + 1] === '`') {
      index += 1
    }
    runs.push({ start, end: index + 1, size: index + 1 - start })
  }

  const nextRuns: (number | undefined)[] = []
  const nextRunBySize = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    nextRuns[index] = nextRunBySize.get(runs[index].size)
    nextRunBySize.set(runs[index].size, index)
  }

  const ranges: SourceRange[] = []
  for (let index = 0; index < runs.length; index += 1) {
    const closeIndex = nextRuns[index]
    if (closeIndex === undefined) {
      continue
    }
    ranges.push({ start: runs[index].start, end: runs[closeIndex].end })
    index = closeIndex
  }
  return ranges
}

function findLinkDestinationRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = []
  for (let index = 0; index < source.length - 1; index += 1) {
    if (source[index] !== ']' || source[index + 1] !== '(') {
      continue
    }
    const start = index + 1
    let depth = 0
    let consumedThrough = source.length
    for (let cursor = start; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') {
        cursor += 1
        continue
      }
      if (source[cursor] === '(') {
        depth += 1
      } else if (source[cursor] === ')') {
        depth -= 1
        if (depth === 0) {
          ranges.push({ start, end: cursor + 1 })
          consumedThrough = cursor
          break
        }
      } else if (source[cursor] === '\n' || source[cursor] === '\r') {
        consumedThrough = cursor
        break
      }
    }
    index = consumedThrough
  }
  return ranges
}

function mergeSourceRanges(left: SourceRange[], right: SourceRange[]): SourceRange[] {
  const ranges: SourceRange[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    if (
      rightIndex >= right.length ||
      (leftIndex < left.length && left[leftIndex].start <= right[rightIndex].start)
    ) {
      ranges.push(left[leftIndex])
      leftIndex += 1
    } else {
      ranges.push(right[rightIndex])
      rightIndex += 1
    }
  }
  return ranges
}

function findSingleDollarOffsets(source: string): number[] {
  const offsets: number[] = []
  const excludedRanges = mergeSourceRanges(
    findBacktickCodeRanges(source),
    findLinkDestinationRanges(source)
  )
  let excludedRangeIndex = 0
  let slashRun = 0
  for (let index = 0; index < source.length; index += 1) {
    while (excludedRanges[excludedRangeIndex]?.end <= index) {
      excludedRangeIndex += 1
    }
    const excludedRange = excludedRanges[excludedRangeIndex]
    const character = source[index]
    if (character === '\\') {
      slashRun += 1
      continue
    }
    if (
      character === '$' &&
      slashRun % 2 === 0 &&
      !(excludedRange !== undefined && excludedRange.start <= index) &&
      source[index - 1] !== '$' &&
      source[index + 1] !== '$'
    ) {
      offsets.push(index)
    }
    slashRun = 0
  }
  return offsets
}

function chooseCurrencyMarker(source: string): string | null {
  const usedCharacters = new Set(source)
  for (let code = FIRST_CURRENCY_MARKER; code <= LAST_CURRENCY_MARKER; code += 1) {
    const marker = String.fromCodePoint(code)
    if (!usedCharacters.has(marker)) {
      return marker
    }
  }
  return null
}

export function maskCurrencyDollars(source: string): MaskedMarkdown | null {
  const offsets = findSingleDollarOffsets(source)
  const maskedOffsets = new Set<number>()
  const protectedClosers = new Set<number>()

  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index]
    if (protectedClosers.has(offset)) {
      continue
    }
    if (closesEscapedCompactValue(source, offset)) {
      maskedOffsets.add(offset)
      continue
    }

    const closer = offsets[index + 1]
    const value = source.slice(offset + 1, closer)
    if (isCurrencyDollarSpan(value, closer !== undefined)) {
      maskedOffsets.add(offset)
    } else if (closer !== undefined) {
      protectedClosers.add(closer)
    }
  }

  if (maskedOffsets.size === 0) {
    return null
  }
  const marker = chooseCurrencyMarker(source)
  if (marker === null) {
    return null
  }
  const characters = source.split('')
  for (const offset of maskedOffsets) {
    characters[offset] = marker
  }
  return { marker, source: characters.join('') }
}

function restoreCurrencyDollars(value: unknown, marker: string): void {
  if (!value || typeof value !== 'object') {
    return
  }
  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      record[key] = child.replaceAll(marker, '$')
    } else {
      restoreCurrencyDollars(child, marker)
    }
  }
}

export function remarkCurrencyAwareMath(this: Processor): undefined {
  const parser = this.parser
  if (parser === undefined) {
    throw new Error('remarkCurrencyAwareMath must run after remarkParse')
  }
  const data = this.data()
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = [])
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = [])

  micromarkExtensions.push(math())
  fromMarkdownExtensions.push(mathFromMarkdown())
  this.parser = (document, file) => {
    const masked = maskCurrencyDollars(String(document))
    const tree = parser(masked?.source ?? document, file)
    if (masked !== null) {
      restoreCurrencyDollars(tree, masked.marker)
    }
    return tree
  }
}
