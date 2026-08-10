import { mathFromMarkdown } from 'mdast-util-math'
import type { Options as FromMarkdownOptions } from 'mdast-util-from-markdown'
import { math } from 'micromark-extension-math'
import type { Nodes, Root } from 'mdast'
import type { Point } from 'unist'
import type { Processor } from 'unified'
import {
  maskCurrencyDollars,
  type CurrencyEscape,
  type MaskedMarkdown
} from './currency-dollar-mask'
import { analyzeMarkdownTextScopes } from './markdown-text-source-ranges'

export {
  isCurrencyDollarSpan,
  maskCurrencyDollars,
  type CurrencyMaskDiagnostics
} from './currency-dollar-mask'

const CURRENCY_AWARE_BASE_PARSER = Symbol('currencyAwareBaseParser')
type MarkdownParser = NonNullable<Processor['parser']>
type CurrencyAwareParser = MarkdownParser & {
  [CURRENCY_AWARE_BASE_PARSER]?: MarkdownParser
}

function constructName(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 1 ? constructName(value[0]) : undefined
  }
  if (typeof value !== 'object' || value === null || !('name' in value)) {
    return undefined
  }
  return typeof value.name === 'string' ? value.name : undefined
}

function isMathMicromarkExtension(extension: unknown): boolean {
  if (typeof extension !== 'object' || extension === null) {
    return false
  }
  const candidate = extension as {
    flow?: Record<number, unknown>
    text?: Record<number, unknown>
  }
  return (
    constructName(candidate.flow?.[36]) === 'mathFlow' &&
    constructName(candidate.text?.[36]) === 'mathText'
  )
}

function hasFunction(record: unknown, key: string): boolean {
  return (
    typeof record === 'object' && record !== null && typeof Reflect.get(record, key) === 'function'
  )
}

function isMathMdastExtension(extension: unknown): boolean {
  if (typeof extension !== 'object' || extension === null) {
    return false
  }
  const candidate = extension as { enter?: unknown; exit?: unknown }
  return (
    hasFunction(candidate.enter, 'mathFlow') &&
    hasFunction(candidate.enter, 'mathText') &&
    hasFunction(candidate.exit, 'mathFlow') &&
    hasFunction(candidate.exit, 'mathText')
  )
}

function normalizeExtensions<T>(
  extensions: T[] | undefined,
  current: T,
  isMathExtension: (extension: unknown) => boolean
): T[] {
  const normalized: T[] = []
  let includedCurrent = false
  for (const extension of extensions ?? []) {
    if (extension === current) {
      if (!includedCurrent) {
        normalized.push(extension)
        includedCurrent = true
      }
    } else if (!isMathExtension(extension)) {
      normalized.push(extension)
    }
  }
  if (!includedCurrent) {
    normalized.push(current)
  }
  return normalized
}

function normalizeProcessorMathExtensions(
  processor: Processor,
  mathMicromarkExtension: NonNullable<ReturnType<typeof math>>,
  mathMdastExtension: ReturnType<typeof mathFromMarkdown>
): {
  mdast: NonNullable<FromMarkdownOptions['mdastExtensions']>
  micromark: NonNullable<FromMarkdownOptions['extensions']>
} {
  const data = processor.data()
  const micromark = normalizeExtensions(
    data.micromarkExtensions,
    mathMicromarkExtension,
    isMathMicromarkExtension
  )
  const mdast = normalizeExtensions(
    (data.fromMarkdownExtensions ?? []).flat(),
    mathMdastExtension,
    isMathMdastExtension
  )
  data.micromarkExtensions = micromark
  data.fromMarkdownExtensions = mdast
  return { mdast, micromark }
}

function restoreCurrencyDollars(node: Nodes, marker: string): number {
  let restored = 0
  if (node.type === 'text') {
    restored = node.value.split(marker).length - 1
    node.value = node.value.replaceAll(marker, '$')
  } else if (
    (node.type === 'image' || node.type === 'imageReference') &&
    typeof node.alt === 'string'
  ) {
    restored = node.alt.split(marker).length - 1
    node.alt = node.alt.replaceAll(marker, '$')
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

function parseCurrencyAwareMarkdown(
  parser: MarkdownParser,
  processor: Processor,
  mathMicromarkExtension: ReturnType<typeof math>,
  mathMdastExtension: ReturnType<typeof mathFromMarkdown>,
  document: Parameters<MarkdownParser>[0],
  file: Parameters<MarkdownParser>[1]
): ReturnType<MarkdownParser> {
  const source = String(document)
  const normalized = normalizeProcessorMathExtensions(
    processor,
    mathMicromarkExtension,
    mathMdastExtension
  )
  if (!source.includes('$')) {
    return parser(document, file)
  }
  const analysis = analyzeMarkdownTextScopes(source, {
    ...processor.data('settings'),
    extensions: normalized.micromark.filter((extension) => !isMathMicromarkExtension(extension)),
    mdastExtensions: normalized.mdast.filter((extension) => !isMathMdastExtension(extension))
  })
  const masked: MaskedMarkdown | null = maskCurrencyDollars(
    source,
    analysis.scopes,
    analysis.decodedCharacters
  )
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

export function remarkCurrencyAwareMath(this: Processor): undefined {
  const configuredParser = this.parser as CurrencyAwareParser | undefined
  if (configuredParser === undefined) {
    throw new Error('remarkCurrencyAwareMath must run after remarkParse')
  }
  const parser = configuredParser[CURRENCY_AWARE_BASE_PARSER] ?? configuredParser
  const mathMicromarkExtension = math()
  const mathMdastExtension = mathFromMarkdown()
  normalizeProcessorMathExtensions(this, mathMicromarkExtension, mathMdastExtension)

  const currencyAwareParser = ((document, file) =>
    parseCurrencyAwareMarkdown(
      parser,
      this,
      mathMicromarkExtension,
      mathMdastExtension,
      document,
      file
    )) as CurrencyAwareParser
  currencyAwareParser[CURRENCY_AWARE_BASE_PARSER] = parser
  this.parser = currencyAwareParser
}
