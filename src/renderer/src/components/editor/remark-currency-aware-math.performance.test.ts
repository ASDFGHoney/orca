import { describe, expect, it, vi } from 'vitest'
import { maskCurrencyDollars, type CurrencyMaskDiagnostics } from './remark-currency-aware-math'

const SIZES = [80_000, 160_000, 320_000] as const

function exactSize(chunk: string, size: number): string {
  return chunk.repeat(Math.ceil(size / chunk.length)).slice(0, size)
}

function diagnosticsFor(source: string): {
  diagnostics: CurrencyMaskDiagnostics
  maskedCount: number
  work: number
} {
  const diagnostics: CurrencyMaskDiagnostics = {
    backwardCodeUnits: 0,
    classifiedCodeUnits: 0,
    dollarOffsets: 0,
    sourceCodeUnits: 0
  }
  const masked = maskCurrencyDollars(source, undefined, undefined, diagnostics)
  if (masked?.marker !== null && masked?.marker !== undefined) {
    expect(masked.source).toHaveLength(source.length)
    expect(masked.source.split(masked.marker)).toHaveLength(masked.maskedCount + 1)
  }
  const work =
    diagnostics.sourceCodeUnits +
    diagnostics.backwardCodeUnits +
    diagnostics.classifiedCodeUnits +
    diagnostics.dollarOffsets
  return { diagnostics, maskedCount: masked?.maskedCount ?? 0, work }
}

describe('currency-aware math performance', () => {
  it.each([
    ['hostile', 'cost $100 then $x$  '],
    ['balanced', 'Math $1+2$ and $x$. ']
  ])('has a deterministic linear work budget for %s input', (_kind, chunk) => {
    const results = SIZES.map((size) => diagnosticsFor(exactSize(chunk, size)))
    for (const [index, result] of results.entries()) {
      expect(result.diagnostics.sourceCodeUnits).toBeGreaterThanOrEqual(SIZES[index])
      expect(result.diagnostics.dollarOffsets).toBeGreaterThan(0)
      expect(result.work).toBeLessThanOrEqual(SIZES[index] * 4 + 32)
    }
    expect(results[1].work).toBeLessThanOrEqual(results[0].work * 2 + 32)
    expect(results[2].work).toBeLessThanOrEqual(results[1].work * 2 + 32)
  })

  it('keeps diagnostics call-local without timers or retained work', () => {
    vi.useFakeTimers()
    try {
      const source = exactSize('cost $100 then $x$  ', 80_000)
      const first = diagnosticsFor(source)
      const second = diagnosticsFor(source)
      expect(second).toEqual(first)
      expect(first.maskedCount).toBeGreaterThan(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
