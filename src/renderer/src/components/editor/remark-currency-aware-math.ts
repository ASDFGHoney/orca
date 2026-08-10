import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import type { Extension } from 'micromark-util-types'
import type { Processor } from 'unified'
import { currencyDollarConstruct, type CurrencyMathDiagnostics } from './currency-dollar-syntax'

export { isCurrencyDollarSpan, type CurrencyMathDiagnostics } from './currency-dollar-syntax'

const CURRENCY_AWARE_BASE_PARSER = Symbol('currencyAwareBaseParser')
type MarkdownParser = NonNullable<Processor['parser']>
type CurrencyAwareParser = MarkdownParser & {
  [CURRENCY_AWARE_BASE_PARSER]?: MarkdownParser
}

function containsConstruct(value: unknown, name: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsConstruct(item, name))
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    Reflect.get(value, 'name') === name
  )
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
    containsConstruct(candidate.flow?.[36], 'mathFlow') &&
    containsConstruct(candidate.text?.[36], 'mathText')
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
  mathMicromarkExtension: Extension,
  mathMdastExtension: ReturnType<typeof mathFromMarkdown>
): void {
  const data = processor.data()
  data.micromarkExtensions = normalizeExtensions(
    data.micromarkExtensions,
    mathMicromarkExtension,
    isMathMicromarkExtension
  )
  data.fromMarkdownExtensions = normalizeExtensions(
    (data.fromMarkdownExtensions ?? []).flat(),
    mathMdastExtension,
    isMathMdastExtension
  )
}

function currencyAwareMathExtension(diagnostics?: CurrencyMathDiagnostics): Extension {
  const extension = math()
  const stockMathText = extension.text?.[36]
  if (stockMathText === undefined) {
    throw new Error('micromark math text construct is unavailable')
  }
  extension.text = {
    ...extension.text,
    36: [
      currencyDollarConstruct(diagnostics),
      ...(Array.isArray(stockMathText) ? stockMathText : [stockMathText])
    ]
  }
  return extension
}

export type RemarkCurrencyAwareMathOptions = {
  diagnostics?: CurrencyMathDiagnostics
}

export function remarkCurrencyAwareMath(
  this: Processor,
  options: RemarkCurrencyAwareMathOptions = {}
): undefined {
  const configuredParser = this.parser as CurrencyAwareParser | undefined
  if (configuredParser === undefined) {
    throw new Error('remarkCurrencyAwareMath must run after remarkParse')
  }
  const parser = configuredParser[CURRENCY_AWARE_BASE_PARSER] ?? configuredParser
  const mathMicromarkExtension = currencyAwareMathExtension(options.diagnostics)
  const mathMdastExtension = mathFromMarkdown()
  normalizeProcessorMathExtensions(this, mathMicromarkExtension, mathMdastExtension)

  const currencyAwareParser = ((document, file) => {
    normalizeProcessorMathExtensions(this, mathMicromarkExtension, mathMdastExtension)
    return parser(document, file)
  }) as CurrencyAwareParser
  currencyAwareParser[CURRENCY_AWARE_BASE_PARSER] = parser
  this.parser = currencyAwareParser
}
