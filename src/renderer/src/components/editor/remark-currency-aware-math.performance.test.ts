import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import type { Code, Construct, State } from 'micromark-util-types'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import type { Processor } from 'unified'
import { unified } from 'unified'
import { describe, expect, it, vi } from 'vitest'
import { remarkCurrencyAwareMath, type CurrencyMathDiagnostics } from './remark-currency-aware-math'

const SIZES = [80_000, 160_000, 320_000] as const

type ParsePassDiagnostics = { attempts: number }

function stockMath(this: Processor): undefined {
  const data = this.data()
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = [])
  micromarkExtensions.push(math())
  fromMarkdownExtensions.push(mathFromMarkdown())
}

function parserPassProbe(this: Processor, diagnostics: ParsePassDiagnostics): undefined {
  const construct: Construct = {
    name: 'parserPassProbe',
    tokenize(_effects, _ok, nok) {
      return function probe(code: Code): State | undefined {
        diagnostics.attempts += 1
        return nok(code)
      }
    }
  }
  const data = this.data()
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  extensions.push({ text: { 64: construct } })
}

function exactSize(chunk: string, size: number): string {
  return chunk.repeat(Math.ceil(size / chunk.length)).slice(0, size)
}

function sparseDocument(size: number): string {
  const prefix = '@'
  const suffix = ' [price $10 to $20](https://example.test?q=1) then $x$'
  return `${prefix}${exactSize('plain text ', size - prefix.length - suffix.length)}${suffix}`
}

function parserPassAttempts(source: string, currencyAware: boolean): number {
  const diagnostics: ParsePassDiagnostics = { attempts: 0 }
  const processor = unified().use(remarkParse).use(remarkGfm).use(parserPassProbe, diagnostics)
  processor.use(currencyAware ? remarkCurrencyAwareMath : stockMath)
  processor.parse(source)
  return diagnostics.attempts
}

function parseDiagnostics(source: string): { diagnostics: CurrencyMathDiagnostics; work: number } {
  const diagnostics: CurrencyMathDiagnostics = {
    classifiedCodeUnits: 0,
    currencyDollars: 0,
    dollarAttempts: 0,
    lookaheadCodes: 0
  }
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCurrencyAwareMath, { diagnostics })
  processor.parse(source)
  const work =
    diagnostics.classifiedCodeUnits +
    diagnostics.currencyDollars +
    diagnostics.dollarAttempts +
    diagnostics.lookaheadCodes
  return { diagnostics, work }
}

describe('currency-aware math performance', () => {
  it('consumes sparse input through configured parser extensions once', () => {
    for (const size of SIZES) {
      const source = sparseDocument(size)
      const stockAttempts = parserPassAttempts(source, false)
      const currencyAwareAttempts = parserPassAttempts(source, true)
      expect(stockAttempts, `${size} code units`).toBeGreaterThan(0)
      expect(currencyAwareAttempts, `${size} code units`).toBe(stockAttempts)
    }
  })

  it.each([
    ['hostile', 'cost $100 then $x$  '],
    ['balanced', 'Math $1+2$ and $x$. ']
  ])('has a deterministic linear parser-path work budget for %s input', (_kind, chunk) => {
    const results = SIZES.map((size) => parseDiagnostics(exactSize(chunk, size)))
    for (const [index, result] of results.entries()) {
      expect(result.diagnostics.dollarAttempts).toBeGreaterThan(0)
      expect(result.diagnostics.lookaheadCodes).toBeGreaterThan(0)
      expect(result.work).toBeLessThanOrEqual(SIZES[index] * 3 + 32)
    }
    expect(results[1].work).toBeLessThanOrEqual(results[0].work * 2 + 32)
    expect(results[2].work).toBeLessThanOrEqual(results[1].work * 2 + 32)
  })

  it('keeps diagnostics call-local without timers or retained work', () => {
    vi.useFakeTimers()
    try {
      const source = exactSize('cost $100 then $x$  ', 80_000)
      const first = parseDiagnostics(source)
      const second = parseDiagnostics(source)
      expect(second).toEqual(first)
      expect(first.diagnostics.currencyDollars).toBeGreaterThan(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
