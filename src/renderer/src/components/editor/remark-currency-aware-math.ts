import { mathFromMarkdown } from 'mdast-util-math'
import type { Extension as FromMarkdownExtension, Handles } from 'mdast-util-from-markdown'
import { math } from 'micromark-extension-math'
import type {
  Construct,
  ConstructRecord,
  Extension as MicromarkExtension
} from 'micromark-util-types'
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

function withoutNamedConstruct(
  record: ConstructRecord | undefined,
  code: number,
  name: string
): ConstructRecord | undefined {
  const value = record?.[code]
  if (value === undefined || !containsConstruct(value, name)) {
    return record
  }
  const constructs = (Array.isArray(value) ? value : [value]).filter(
    (construct: Construct) => construct.name !== name
  )
  const normalized = { ...record }
  if (constructs.length === 0) {
    delete normalized[code]
  } else {
    normalized[code] = Array.isArray(value) ? constructs : constructs[0]
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized
}

function withoutStockMathMicromark(extension: MicromarkExtension): MicromarkExtension | undefined {
  const hasCurrencyDollar = containsConstruct(extension.text?.[36], 'currencyDollar')
  const hasStockMath = isMathMicromarkExtension(extension)
  if (!hasCurrencyDollar && !hasStockMath) {
    return extension
  }
  const normalized = { ...extension }
  const flow = hasStockMath ? withoutNamedConstruct(extension.flow, 36, 'mathFlow') : extension.flow
  let text = hasStockMath ? withoutNamedConstruct(extension.text, 36, 'mathText') : extension.text
  if (hasCurrencyDollar) {
    text = withoutNamedConstruct(text, 36, 'currencyDollar')
  }
  if (flow === undefined) {
    delete normalized.flow
  } else {
    normalized.flow = flow
  }
  if (text === undefined) {
    delete normalized.text
  } else {
    normalized.text = text
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized
}

function withoutHandleKeys(
  handles: Handles | null | undefined,
  keys: string[]
): Handles | undefined {
  if (handles === null || handles === undefined) {
    return undefined
  }
  const normalized = { ...handles }
  for (const key of keys) {
    delete normalized[key]
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized
}

function withoutStockMathMdast(
  extension: FromMarkdownExtension,
  stockMath: FromMarkdownExtension
): FromMarkdownExtension | undefined {
  if (!isMathMdastExtension(extension)) {
    return extension
  }
  const normalized = { ...extension }
  const enter = withoutHandleKeys(extension.enter, Object.keys(stockMath.enter ?? {}))
  const exit = withoutHandleKeys(extension.exit, Object.keys(stockMath.exit ?? {}))
  if (enter === undefined) {
    delete normalized.enter
  } else {
    normalized.enter = enter
  }
  if (exit === undefined) {
    delete normalized.exit
  } else {
    normalized.exit = exit
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized
}

function normalizeExtensions<T>(
  extensions: T[] | undefined,
  current: T,
  withoutStockMath: (extension: T) => T | undefined
): T[] {
  const normalized: T[] = []
  let includedCurrent = false
  for (const extension of extensions ?? []) {
    if (extension === current) {
      if (!includedCurrent) {
        normalized.push(extension)
        includedCurrent = true
      }
    } else {
      const preserved = withoutStockMath(extension)
      if (preserved !== undefined) {
        normalized.push(preserved)
      }
    }
  }
  if (!includedCurrent) {
    normalized.push(current)
  }
  return normalized
}

function normalizeProcessorMathExtensions(
  processor: Processor,
  mathMicromarkExtension: MicromarkExtension,
  mathMdastExtension: ReturnType<typeof mathFromMarkdown>
): void {
  const data = processor.data()
  data.micromarkExtensions = normalizeExtensions(
    data.micromarkExtensions,
    mathMicromarkExtension,
    withoutStockMathMicromark
  )
  data.fromMarkdownExtensions = normalizeExtensions(
    (data.fromMarkdownExtensions ?? []).flat(),
    mathMdastExtension,
    (extension) => withoutStockMathMdast(extension, mathMdastExtension)
  )
}

function currencyAwareMathExtension(diagnostics?: CurrencyMathDiagnostics): MicromarkExtension {
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
