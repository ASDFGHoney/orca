import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import type { Nodes, Root } from 'mdast'
import type { Point } from 'unist'
import type { Processor } from 'unified'
import {
  analyzeMarkdownTextScopes,
  type MarkdownSourceRange,
  type MarkdownTextScope
} from './markdown-text-source-ranges'

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
const MATH_OPERATOR = '(?:[+\\-−＋－*/<>=]|,|\\\\[A-Za-z]+|mod|div)'
const NUMERIC_MATH_EXPRESSION = new RegExp(
  `^${NUMERIC_LITERAL}(?:\\s*${MATH_OPERATOR}\\s*${MATH_OPERAND})+$`,
  'u'
)
const CURRENCY_RANGE_SYNTAX = /[→~～〜–—]/u
const PROSE_BOUNDARY = /[\s;:；：,，。！？!?、]/u
const COMPACT_VALUE = /^[^\s$]+$/u
const FIRST_CURRENCY_MARKER = 0xe000
const LAST_CURRENCY_MARKER = 0xf8ff

type CurrencyEscape = { maskedOffset: number; line: number }
type MaskedMarkdown = {
  escapes: CurrencyEscape[]
  marker: string | null
  maskedCount: number
  source: string
}
type SourceRange = MarkdownSourceRange
type TextScope = MarkdownTextScope

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

function findSingleDollarOffsets(source: string, ranges: SourceRange[]): number[] {
  const offsets: number[] = []
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (
        source[index] === '$' &&
        !isEscaped(source, index) &&
        source[index - 1] !== '$' &&
        source[index + 1] !== '$'
      ) {
        offsets.push(index)
      }
    }
  }
  return offsets
}

function chooseCurrencyMarker(source: string, decodedCharacters: Set<string>): string | null {
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

function collectMaskedOffsets(source: string, scopes: TextScope[]): Set<number> {
  const maskedOffsets = new Set<number>()
  for (const ranges of scopes) {
    const offsets = findSingleDollarOffsets(source, ranges)
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
  }
  return maskedOffsets
}

function escapeCurrencyDollars(source: string, offsets: number[]): MaskedMarkdown {
  const chunks: string[] = []
  const escapes: CurrencyEscape[] = []
  let cursor = 0
  let line = 1
  let scanCursor = 0
  for (const [index, offset] of offsets.entries()) {
    for (; scanCursor < offset; scanCursor += 1) {
      if (source[scanCursor] === '\n' || source[scanCursor] === '\r') {
        if (source[scanCursor] === '\r' && source[scanCursor + 1] === '\n') {
          scanCursor += 1
        }
        line += 1
      }
    }
    chunks.push(source.slice(cursor, offset), '\\$')
    escapes.push({
      line,
      maskedOffset: offset + index
    })
    cursor = offset + 1
  }
  chunks.push(source.slice(cursor))
  return { escapes, marker: null, maskedCount: offsets.length, source: chunks.join('') }
}

export function maskCurrencyDollars(
  source: string,
  scopes: TextScope[] = [[{ start: 0, end: source.length }]],
  decodedCharacters = new Set<string>()
): MaskedMarkdown | null {
  const maskedOffsets = collectMaskedOffsets(source, scopes)
  if (maskedOffsets.size === 0) {
    return null
  }
  const offsets = [...maskedOffsets].sort((left, right) => left - right)
  const marker = chooseCurrencyMarker(source, decodedCharacters)
  if (marker === null) {
    return escapeCurrencyDollars(source, offsets)
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

function restoreCurrencyDollars(node: Nodes, marker: string): number {
  let restored = 0
  if (node.type === 'text') {
    restored = node.value.split(marker).length - 1
    node.value = node.value.replaceAll(marker, '$')
  }
  if ('children' in node) {
    restored += node.children.reduce(
      (count, child) => count + restoreCurrencyDollars(child, marker),
      0
    )
  }
  return restored
}

function countBefore(sorted: number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (sorted[middle] < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

function restorePoint(
  point: Point,
  escapeOffsets: number[],
  lineOffsets: Map<number, number[]>
): void {
  if (point.offset === undefined) {
    return
  }
  const originalOffset = point.offset - countBefore(escapeOffsets, point.offset)
  const sameLineOffsets = lineOffsets.get(point.line) ?? []
  point.column -= countBefore(sameLineOffsets, point.offset)
  point.offset = originalOffset
}

function restoreEscapedPositions(tree: Root, escapes: CurrencyEscape[]): void {
  const escapeOffsets = escapes.map((escape) => escape.maskedOffset)
  const lineOffsets = new Map<number, number[]>()
  for (const escape of escapes) {
    const offsets = lineOffsets.get(escape.line) ?? []
    offsets.push(escape.maskedOffset)
    lineOffsets.set(escape.line, offsets)
  }
  const visitNode = (node: Nodes): void => {
    if (node.position !== undefined) {
      restorePoint(node.position.start, escapeOffsets, lineOffsets)
      restorePoint(node.position.end, escapeOffsets, lineOffsets)
    }
    if ('children' in node) {
      node.children.forEach(visitNode)
    }
  }
  visitNode(tree)
}

export function remarkCurrencyAwareMath(this: Processor): undefined {
  const parser = this.parser
  if (parser === undefined) {
    throw new Error('remarkCurrencyAwareMath must run after remarkParse')
  }
  const data = this.data()
  const settings = this.data('settings')
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = [])
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = [])

  const mathMicromarkExtension = math()
  const mathMdastExtension = mathFromMarkdown()
  micromarkExtensions.push(mathMicromarkExtension)
  fromMarkdownExtensions.push(mathMdastExtension)
  this.parser = (document, file) => {
    const source = String(document)
    if (!source.includes('$')) {
      return parser(document, file)
    }
    const analysis = analyzeMarkdownTextScopes(source, {
      ...settings,
      extensions: micromarkExtensions.filter((extension) => extension !== mathMicromarkExtension),
      mdastExtensions: fromMarkdownExtensions.filter(
        (extension) => extension !== mathMdastExtension
      )
    })
    const masked = maskCurrencyDollars(source, analysis.scopes, analysis.decodedCharacters)
    const tree = parser(masked?.source ?? document, file)
    if (masked?.marker !== null && masked?.marker !== undefined) {
      const restored = restoreCurrencyDollars(tree as Root, masked.marker)
      if (restored !== masked.maskedCount) {
        throw new Error('Currency marker restoration count did not match the mask')
      }
    } else if (masked !== null) {
      restoreEscapedPositions(tree as Root, masked.escapes)
    }
    return tree
  }
}
