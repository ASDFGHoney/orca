import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { visit } from 'unist-util-visit'
import { toString } from 'mdast-util-to-string'
import {
  isCurrencyFalsePositiveInlineMath,
  isCurrencyLikeMathValue,
  remarkDemoteCurrencyMath
} from './remark-demote-currency-math'

type MathNode = { type: string; value?: string }

function parseWithCurrencyGuard(source: string): {
  math: MathNode[]
  text: string
} {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkDemoteCurrencyMath)
  const tree = processor.parse(source)
  processor.runSync(tree)

  const math: MathNode[] = []
  visit(tree, (node) => {
    if (node.type === 'inlineMath' || node.type === 'math') {
      math.push({ type: node.type, value: 'value' in node ? String(node.value ?? '') : '' })
    }
  })

  return { math, text: toString(tree) }
}

function parseWithoutGuard(source: string): MathNode[] {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  const tree = processor.parse(source)
  processor.runSync(tree)
  const math: MathNode[] = []
  visit(tree, (node) => {
    if (node.type === 'inlineMath' || node.type === 'math') {
      math.push({ type: node.type, value: 'value' in node ? String(node.value ?? '') : '' })
    }
  })
  return math
}

// Issue #13330 reproduction string
const ISSUE_CURRENCY_PROSE =
  '月成本 **$148+ → $19**（省 **87%**，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'

describe('isCurrencyFalsePositiveInlineMath', () => {
  it('detects closing $ before a digit', () => {
    expect(
      isCurrencyFalsePositiveInlineMath(
        { type: 'inlineMath', value: '148+ → ' },
        { type: 'text', value: '19' }
      )
    ).toBe(true)
  })

  it('detects pure currency amounts', () => {
    expect(isCurrencyFalsePositiveInlineMath({ type: 'inlineMath', value: '100' }, undefined)).toBe(
      true
    )
    expect(
      isCurrencyFalsePositiveInlineMath({ type: 'inlineMath', value: '1,550' }, undefined)
    ).toBe(true)
    expect(
      isCurrencyFalsePositiveInlineMath({ type: 'inlineMath', value: '15.4' }, undefined)
    ).toBe(true)
  })

  it('keeps real math values', () => {
    expect(
      isCurrencyFalsePositiveInlineMath({ type: 'inlineMath', value: 'E=mc^2' }, undefined)
    ).toBe(false)
    expect(
      isCurrencyFalsePositiveInlineMath(
        { type: 'inlineMath', value: 'x' },
        { type: 'text', value: ' more' }
      )
    ).toBe(false)
    expect(isCurrencyLikeMathValue('2+2')).toBe(false)
    expect(isCurrencyLikeMathValue('2^n')).toBe(false)
    expect(isCurrencyLikeMathValue('1,550 and ')).toBe(true)
  })
})

describe('remarkDemoteCurrencyMath', () => {
  it('preserves the issue currency string with all $ signs (CJK prose)', () => {
    // Without the guard, remark-math swallows two currency spans.
    expect(parseWithoutGuard(ISSUE_CURRENCY_PROSE)).toHaveLength(2)

    const { math, text } = parseWithCurrencyGuard(ISSUE_CURRENCY_PROSE)
    expect(math).toEqual([])
    expect(text).toBe(
      '月成本 $148+ → $19（省 87%，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'
    )
    expect((text.match(/\$/g) ?? []).length).toBe(4)
  })

  it('preserves balanced inline math', () => {
    const { math, text } = parseWithCurrencyGuard('Einstein wrote $E=mc^2$ in 1905.')
    expect(math).toEqual([{ type: 'inlineMath', value: 'E=mc^2' }])
    expect(text).toBe('Einstein wrote E=mc^2 in 1905.')
  })

  it('preserves display math with $$', () => {
    const source = 'Area:\n\n$$\n\\int_0^1 x\\,dx\n$$\n'
    const { math } = parseWithCurrencyGuard(source)
    expect(math.some((node) => node.type === 'math')).toBe(true)
    expect(math.some((node) => node.value?.includes('int'))).toBe(true)
  })

  it('leaves unbalanced single $ currency amounts alone', () => {
    const source = 'Cost is $1,550 total and later $15.4/月'
    const { math, text } = parseWithCurrencyGuard(source)
    expect(math).toEqual([])
    expect(text).toBe(source)
  })

  it('preserves escaped dollars', () => {
    const { math, text } = parseWithCurrencyGuard('Price is \\$19 only')
    expect(math).toEqual([])
    expect(text).toBe('Price is $19 only')
  })

  it('demotes pure numeric $100$ currency pairs', () => {
    const { math, text } = parseWithCurrencyGuard('costs $100$ exactly')
    expect(math).toEqual([])
    expect(text).toBe('costs $100$ exactly')
  })

  it('demotes $10 to $20 ranges while keeping neighboring real math', () => {
    const { math, text } = parseWithCurrencyGuard('from $10 to $20 and math $x+y$')
    expect(math).toEqual([{ type: 'inlineMath', value: 'x+y' }])
    expect(text).toBe('from $10 to $20 and math x+y')
  })

  it('preserves neighboring Markdown (bold, code spans, fences)', () => {
    const source = [
      '**bold $E=mc^2$ math** and `$notmath$` code',
      '',
      '```',
      '$100',
      '```',
      '',
      'currency **$148+ → $19** end'
    ].join('\n')

    const { math, text } = parseWithCurrencyGuard(source)
    expect(math).toEqual([{ type: 'inlineMath', value: 'E=mc^2' }])
    expect(text).toContain('bold E=mc^2 math')
    expect(text).toContain('$notmath$')
    expect(text).toContain('$100')
    expect(text).toContain('$148+ → $19')
  })

  it('does not let currency spans swallow following math', () => {
    const { math, text } = parseWithCurrencyGuard('pay ~$1,550 and then $E=mc^2$')
    expect(math).toEqual([{ type: 'inlineMath', value: 'E=mc^2' }])
    expect(text).toBe('pay ~$1,550 and then E=mc^2')
  })

  it('is linear over large mixed documents (perf smoke)', () => {
    const chunk = '月成本 **$148+ → $19** and math $a+b$ plus lone ~$1,550 then $E=mc^2$.\n\n'
    const source = chunk.repeat(2_000)
    const start = performance.now()
    const { math, text } = parseWithCurrencyGuard(source)
    const elapsedMs = performance.now() - start

    // 2000 chunks × 2 real math nodes; currency demotions restore plain `$`.
    expect(math.filter((node) => node.value === 'a+b')).toHaveLength(2_000)
    expect(math.filter((node) => node.value === 'E=mc^2')).toHaveLength(2_000)
    expect(text).toContain('$148+ → $19')
    expect(text).toContain('~$1,550')
    // Why: guard must stay O(n); multi-second parse on ~200KB would regress preview.
    expect(elapsedMs).toBeLessThan(2_000)
  })
})
