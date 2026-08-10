import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { toString } from 'mdast-util-to-string'
import {
  isCurrencyDollarSpan,
  maskCurrencyDollars,
  remarkCurrencyAwareMath
} from './remark-currency-aware-math'

type MathNode = { type: string; value?: string }

function parseMarkdown(source: string): {
  math: MathNode[]
  nodeTypes: string[]
  text: string
} {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCurrencyAwareMath)
  const tree = processor.runSync(processor.parse(source))
  const math: MathNode[] = []
  const nodeTypes: string[] = []
  visit(tree, (node) => {
    nodeTypes.push(node.type)
    if (node.type === 'inlineMath' || node.type === 'math') {
      math.push({ type: node.type, value: 'value' in node ? String(node.value ?? '') : '' })
    }
  })
  return { math, nodeTypes, text: toString(tree) }
}

const ISSUE_CURRENCY_PROSE =
  '月成本 **$148+ → $19**（省 **87%**，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'

describe('isCurrencyDollarSpan', () => {
  it('claims numeric openers whose next dollar closes prose', () => {
    expect(isCurrencyDollarSpan('148 a month to ', true)).toBe(true)
    expect(isCurrencyDollarSpan('1,550/月公式', true)).toBe(true)
    expect(isCurrencyDollarSpan('1,550원 현재', true)).toBe(true)
    expect(isCurrencyDollarSpan('148+ → ', true)).toBe(true)
  })

  it('leaves balanced numeric and numeric-leading expressions to stock math', () => {
    for (const value of ['-1', '3.14', '.5', '6.022e23', '1,000', '１２３', '2+2', '2 mod 3']) {
      expect(isCurrencyDollarSpan(value, true), value).toBe(false)
    }
  })

  it('claims an unbalanced numeric opener without classifying its locale suffix', () => {
    expect(isCurrencyDollarSpan('19', false)).toBe(true)
    expect(isCurrencyDollarSpan('1.550,00/month', false)).toBe(true)
    expect(isCurrencyDollarSpan('x', false)).toBe(false)
  })
})

describe('remarkCurrencyAwareMath', () => {
  it('preserves the issue currency string as plain text', () => {
    const { math, text } = parseMarkdown(ISSUE_CURRENCY_PROSE)
    expect(math).toEqual([])
    expect(text).toBe(
      '月成本 $148+ → $19（省 87%，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'
    )
    expect(text.match(/\$/g)).toHaveLength(4)
  })

  it('passes all required currency and numeric-math regressions', () => {
    expect(parseMarkdown('From $148 a month to $19')).toEqual(
      expect.objectContaining({ math: [], text: 'From $148 a month to $19' })
    )
    expect(parseMarkdown('成本$1,550/月公式$x$')).toEqual(
      expect.objectContaining({
        math: [{ type: 'inlineMath', value: 'x' }],
        text: '成本$1,550/月公式x'
      })
    )
    expect(parseMarkdown('The roots are $-1$ and $1$.')).toEqual(
      expect.objectContaining({
        math: [
          { type: 'inlineMath', value: '-1' },
          { type: 'inlineMath', value: '1' }
        ],
        text: 'The roots are -1 and 1.'
      })
    )
  })

  it('preserves common English and Korean currency prose', () => {
    for (const source of [
      'It cost $148 a month, now $19.',
      'Pay $148 for a month and then $19.',
      'Pay $148 on a monthly plan, then $19.',
      '비용$1,550원 현재$19원',
      '월 비용$1,550/월 현재$19/월',
      '월 비용$1,550달러 현재$19달러'
    ]) {
      const { math, text } = parseMarkdown(source)
      expect(math, source).toEqual([])
      expect(text, source).toBe(source)
    }
  })

  it('preserves locale-shaped amounts and CJK currency suffixes', () => {
    for (const source of [
      'Cost $1 550 now, then $19.',
      'Cost $1’550 now, then $19.',
      'Cost $1.550,00 now, then $19.',
      '成本$1,550円、現在$19円',
      '成本$1,550ウォン、現在$19ウォン',
      '成本$1,550/月，現在$19/月',
      '成本$1,550每月，現在$19每月'
    ]) {
      const { math, text } = parseMarkdown(source)
      expect(math, source).toEqual([])
      expect(text, source).toBe(source)
    }
  })

  it('preserves stock numeric math without prose-context exceptions', () => {
    const source = 'The values are $1$, $-2.5$, $.5$, $6.022e23$, $-2.5e-4$, $1,000$, and $１２３$.'
    const { math, text } = parseMarkdown(source)
    expect(math.map((node) => node.value)).toEqual([
      '1',
      '-2.5',
      '.5',
      '6.022e23',
      '-2.5e-4',
      '1,000',
      '１２３'
    ])
    expect(text).toBe('The values are 1, -2.5, .5, 6.022e23, -2.5e-4, 1,000, and １２３.')
    expect(parseMarkdown('Use $3.14$ radians.').math).toEqual([
      { type: 'inlineMath', value: '3.14' }
    ])
  })

  it('preserves stock numeric-leading expression forms', () => {
    const { math } = parseMarkdown(
      'Math $2+2$, $10-20$, $2 mod 3$, $1 + x$, $1/x$, $12xyz$, and $2π$.'
    )
    expect(math.map((node) => node.value)).toEqual([
      '2+2',
      '10-20',
      '2 mod 3',
      '1 + x',
      '1/x',
      '12xyz',
      '2π'
    ])
  })

  it('leaves stock symbolic math forms unchanged', () => {
    const { math, text } = parseMarkdown(
      'Math $E=mc^2$, $ x y $, $12xyz$, $2π$, $x$23, and $text$.'
    )
    expect(math.map((node) => node.value)).toEqual(['E=mc^2', 'x y', '12xyz', '2π', 'x', 'text'])
    expect(text).toBe('Math E=mc^2, x y, 12xyz, 2π, x23, and text.')
  })

  it('lets the next dollar open math after a currency opener is claimed', () => {
    const source = 'cost $100 and math $x$; 成本$1,550/月公式$y$; 비용$19원 수식$z$'
    const { math, text } = parseMarkdown(source)
    expect(math.map((node) => node.value)).toEqual(['x', 'y', 'z'])
    expect(text).toBe('cost $100 and math x; 成本$1,550/月公式y; 비용$19원 수식z')
  })

  it('preserves currency ranges while closed numeric ranges remain math', () => {
    const source =
      'Ranges $-5 → $-2, $.99→$.19, $１００→$１９, and $＋１００～$１９ stay literal; math $10-20$.'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([{ type: 'inlineMath', value: '10-20' }])
    expect(text).toBe(
      'Ranges $-5 → $-2, $.99→$.19, $１００→$１９, and $＋１００～$１９ stay literal; math 10-20.'
    )
  })

  it('preserves escaped dollars without stealing later math delimiters', () => {
    const source = 'Escaped \\$19 and \\$x$ stay literal; \\$19$ and $y$ stays math.'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([{ type: 'inlineMath', value: 'y' }])
    expect(text).toBe('Escaped $19 and $x$ stay literal; $19$ and y stays math.')
  })

  it('keeps inline and display double-dollar math unchanged', () => {
    const source = 'Inline $$x^2$$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n'
    expect(parseMarkdown(source).math).toEqual([
      { type: 'inlineMath', value: 'x^2' },
      { type: 'math', value: '\\int_0^1 x\\,dx' }
    ])
  })

  it('preserves Markdown structure around currency and math', () => {
    const source = [
      '**from $10 to $20** and [linked $30](https://example.com) plus `$notmath$`',
      '',
      'Real math $x$',
      '',
      '```',
      '$100 and $y$',
      '```'
    ].join('\n')
    const { math, nodeTypes, text } = parseMarkdown(source)
    expect(math).toEqual([{ type: 'inlineMath', value: 'x' }])
    expect(text).toContain('from $10 to $20')
    expect(text).toContain('linked $30')
    expect(text).toContain('$notmath$')
    expect(text).toContain('$100 and $y$')
    expect(nodeTypes).toEqual(expect.arrayContaining(['strong', 'link', 'inlineCode', 'code']))

    const codeBeforeCurrency = parseMarkdown('`$ignored` then $19 then $y$')
    expect(codeBeforeCurrency.math).toEqual([{ type: 'inlineMath', value: 'y' }])
    expect(codeBeforeCurrency.text).toBe('$ignored then $19 then y')

    const linkBeforeCurrency = parseMarkdown(
      '[link](https://example.test/$ignored) then $19 then $z$'
    )
    expect(linkBeforeCurrency.math).toEqual([{ type: 'inlineMath', value: 'z' }])
    expect(linkBeforeCurrency.text).toBe('link then $19 then z')

    const escapedBackticks = parseMarkdown('\\`literal\\` then $19 then $w$')
    expect(escapedBackticks.math).toEqual([{ type: 'inlineMath', value: 'w' }])
    expect(escapedBackticks.text).toBe('`literal` then $19 then w')
  })

  it('preserves source offsets and never leaks the private marker', () => {
    const source = '😀 cost $148 a month, formula $x$.'
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCurrencyAwareMath)
    const tree = processor.runSync(processor.parse(source))
    let mathOffsets: { end?: number; start?: number } | undefined
    visit(tree, (node) => {
      if (node.type === 'inlineMath') {
        mathOffsets = { start: node.position?.start.offset, end: node.position?.end.offset }
      }
    })
    const mathStart = source.indexOf('$x$')
    expect(mathOffsets).toEqual({ start: mathStart, end: mathStart + 3 })
    expect(JSON.stringify(tree)).not.toMatch(/[\uE000-\uF8FF]/u)
    expect(toString(tree)).toBe('😀 cost $148 a month, formula x.')
  })

  it('keeps unbalanced and pathological dollar runs bounded', () => {
    expect(parseMarkdown('$x')).toEqual(expect.objectContaining({ math: [], text: '$x' }))
    expect(parseMarkdown('$100 and then $x$')).toEqual(
      expect.objectContaining({
        math: [{ type: 'inlineMath', value: 'x' }],
        text: '$100 and then x'
      })
    )
    expect(parseMarkdown('$100$$x$').math).toEqual([{ type: 'inlineMath', value: '100$$x' }])
    const dollars = '$'.repeat(20_000)
    expect(parseMarkdown(dollars)).toEqual(
      expect.objectContaining({ math: [{ type: 'math', value: '' }], text: '' })
    )
  })

  it('keeps currency dollars in plain-text extraction', () => {
    const source = 'It cost **$148 a month**, now $19; formula $x$.'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([{ type: 'inlineMath', value: 'x' }])
    expect(text).toBe('It cost $148 a month, now $19; formula x.')
    expect(text.match(/\$/g)).toHaveLength(2)
  })

  it('scales across 80k, 160k, and 320k mixed-dollar inputs', () => {
    const chunk = 'cost $100 then $x$  '
    maskCurrencyDollars(chunk.repeat(100))
    const durations = [4_000, 8_000, 16_000].map((count) => {
      const source = chunk.repeat(count)
      const start = performance.now()
      const masked = maskCurrencyDollars(source)
      const duration = performance.now() - start
      if (masked === null) {
        throw new Error('Expected a private-use currency marker')
      }
      expect(source).toHaveLength(count * 20)
      expect(masked.source).toHaveLength(source.length)
      expect(masked.source.match(new RegExp(masked.marker, 'gu'))).toHaveLength(count)
      return duration
    })
    expect(durations[2]).toBeLessThan(durations[0] * 8 + 50)
    expect(durations[2]).toBeLessThan(500)
  })
})
