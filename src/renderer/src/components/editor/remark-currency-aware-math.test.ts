import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { toString } from 'mdast-util-to-string'
import { isIntentionalInlineMath, remarkCurrencyAwareMath } from './remark-currency-aware-math'

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

describe('isIntentionalInlineMath', () => {
  it('rejects currency amounts and closers before digits', () => {
    expect(isIntentionalInlineMath('100', null)).toBe(false)
    expect(isIntentionalInlineMath('1,550', null)).toBe(false)
    expect(isIntentionalInlineMath('148+ → ', '1'.codePointAt(0)!)).toBe(false)
    expect(isIntentionalInlineMath('-5 → ', '-'.codePointAt(0)!)).toBe(false)
    expect(isIntentionalInlineMath('.99→', '.'.codePointAt(0)!)).toBe(false)
    expect(isIntentionalInlineMath('１００→', '１'.codePointAt(0)!)).toBe(false)
    expect(isIntentionalInlineMath('＋１００～', '１'.codePointAt(0)!)).toBe(false)
    expect(isIntentionalInlineMath('1,550；公式', 'x'.codePointAt(0)!)).toBe(false)
  })

  it('accepts stock single-dollar math forms', () => {
    expect(isIntentionalInlineMath('E=mc^2', null)).toBe(true)
    expect(isIntentionalInlineMath('2+2', null)).toBe(true)
    expect(isIntentionalInlineMath(' x y ', null)).toBe(true)
    expect(isIntentionalInlineMath('2 mod 3', null)).toBe(true)
    expect(isIntentionalInlineMath('12xyz', null)).toBe(true)
    expect(isIntentionalInlineMath('2π', null)).toBe(true)
    expect(isIntentionalInlineMath('2+2 ', null)).toBe(true)
    expect(isIntentionalInlineMath('2 mod 3 ', null)).toBe(true)
  })
})

describe('remarkCurrencyAwareMath', () => {
  it('preserves the issue currency string as CJK prose', () => {
    const { math, text } = parseMarkdown(ISSUE_CURRENCY_PROSE)
    expect(math).toEqual([])
    expect(text).toBe(
      '月成本 $148+ → $19（省 87%，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'
    )
    expect(text.match(/\$/g)).toHaveLength(4)
  })

  it('parses true inline math without narrowing stock syntax', () => {
    const { math, text } = parseMarkdown(
      'Math $E=mc^2$, $ x y $, $2 mod 3$, $12xyz$, $2π$, $x$23, and $text$.'
    )
    expect(math).toEqual([
      { type: 'inlineMath', value: 'E=mc^2' },
      { type: 'inlineMath', value: 'x y' },
      { type: 'inlineMath', value: '2 mod 3' },
      { type: 'inlineMath', value: '12xyz' },
      { type: 'inlineMath', value: '2π' },
      { type: 'inlineMath', value: 'x' },
      { type: 'inlineMath', value: 'text' }
    ])
    expect(text).toBe('Math E=mc^2, x y, 2 mod 3, 12xyz, 2π, x23, and text.')
  })

  it('parses inline and block double-dollar math', () => {
    const source = 'Inline $$x^2$$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n'
    const { math } = parseMarkdown(source)
    expect(math).toEqual([
      { type: 'inlineMath', value: 'x^2' },
      { type: 'math', value: '\\int_0^1 x\\,dx' }
    ])
  })

  it('leaves unbalanced and numeric dollar spans literal', () => {
    const source = 'Cost is $1,550 total, later $15.4/月, or exactly $100$.'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([])
    expect(text).toBe(source)
  })

  it('preserves signed, leading-decimal, and full-width currency ranges', () => {
    const source = 'Ranges $-5 → $-2, $.99→$.19, $１００→$１９, and $＋１００～$１９ stay literal.'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([])
    expect(text).toBe(source)
  })

  it('preserves escaped dollars without stealing neighboring math delimiters', () => {
    const source = 'Escaped \\$19 and \\$x$ stay literal; \\$19$ and $y$ stays math.'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([{ type: 'inlineMath', value: 'y' }])
    expect(text).toBe('Escaped $19 and $x$ stay literal; $19$ and y stays math.')
  })

  it('does not reuse rejected currency closers as math openers', () => {
    const source = 'cost $100$ and math $x$; also $-5$ then $y$ and $１００$ then $z$'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([
      { type: 'inlineMath', value: 'x' },
      { type: 'inlineMath', value: 'y' },
      { type: 'inlineMath', value: 'z' }
    ])
    expect(text).toBe('cost $100$ and math x; also $-5$ then y and $１００$ then z')
  })

  it('keeps pure currency closed before adjacent Markdown and CJK', () => {
    const source = [
      'cost $100$[link](https://example.com) then $x$',
      'cost $100$**bold** then $y$',
      'cost $100$`code` then $z$',
      'cost $100$后续 then $w$'
    ].join('\n')
    const { math, nodeTypes, text } = parseMarkdown(source)
    expect(math).toEqual([
      { type: 'inlineMath', value: 'x' },
      { type: 'inlineMath', value: 'y' },
      { type: 'inlineMath', value: 'z' },
      { type: 'inlineMath', value: 'w' }
    ])
    expect(text).toContain('cost $100$link then x')
    expect(text).toContain('cost $100$bold then y')
    expect(text).toContain('cost $100$code then z')
    expect(text).toContain('cost $100$后续 then w')
    expect(nodeTypes).toContain('link')
    expect(nodeTypes).toContain('strong')
    expect(nodeTypes).toContain('inlineCode')
  })

  it('separates currency range prose from later numeric math', () => {
    const source = 'Budget $10–20 and formula $x$; math $10-20$ and $2 mod 3$ remain formulas.'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([
      { type: 'inlineMath', value: 'x' },
      { type: 'inlineMath', value: '10-20' },
      { type: 'inlineMath', value: '2 mod 3' }
    ])
    expect(text).toBe('Budget $10–20 and formula x; math 10-20 and 2 mod 3 remain formulas.')
  })

  it('does not pair unbalanced currency with later CJK math', () => {
    const source = '成本$1,550；公式$x$；月费$15.4/月；公式$E=mc^2$'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([
      { type: 'inlineMath', value: 'x' },
      { type: 'inlineMath', value: 'E=mc^2' }
    ])
    expect(text).toBe('成本$1,550；公式x；月费$15.4/月；公式E=mc^2')
  })

  it('keeps compact CJK currency prose before real math', () => {
    const { math, text } = parseMarkdown('成本$1,550元公式$x$')
    expect(math).toEqual([{ type: 'inlineMath', value: 'x' }])
    expect(text).toBe('成本$1,550元公式x')
  })

  it('keeps an English currency range literal', () => {
    const source = 'From $148+ to $19'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([])
    expect(text).toBe(source)
  })

  it('keeps a prose currency range literal', () => {
    const source = 'From $148 a month to $19'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([])
    expect(text).toBe(source)
  })

  it('keeps compact CJK monthly currency before real math', () => {
    const { math, text } = parseMarkdown('成本$1,550/月公式$x$')
    expect(math).toEqual([{ type: 'inlineMath', value: 'x' }])
    expect(text).toBe('成本$1,550/月公式x')
  })

  it('parses signed numeric values in mathematical prose', () => {
    const { math, text } = parseMarkdown('The roots are $-1$ and $1$.')
    expect(math).toEqual([
      { type: 'inlineMath', value: '-1' },
      { type: 'inlineMath', value: '1' }
    ])
    expect(text).toBe('The roots are -1 and 1.')
  })

  it('separates adjacent currency and math spans', () => {
    const { math, text } = parseMarkdown('cost $100$$x$')
    expect(math).toEqual([{ type: 'inlineMath', value: 'x' }])
    expect(text).toBe('cost $100$x')
  })

  it('handles micromark virtual codes after numeric-leading math', () => {
    const source = '$2+2$\nnext\n\n$2 mod 3$\tmore'
    const { math, text } = parseMarkdown(source)
    expect(math).toEqual([
      { type: 'inlineMath', value: '2+2' },
      { type: 'inlineMath', value: '2 mod 3' }
    ])
    expect(text).toBe('2+2\nnext2 mod 3\tmore')
  })

  it('keeps multiple formulas after currency paired independently', () => {
    const { math, text } = parseMarkdown('pay $1,550 then $x$ and $y$')
    expect(math).toEqual([
      { type: 'inlineMath', value: 'x' },
      { type: 'inlineMath', value: 'y' }
    ])
    expect(text).toBe('pay $1,550 then x and y')
  })

  it('preserves neighboring bold, links, code spans, and fences', () => {
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
    expect(nodeTypes).toContain('strong')
    expect(nodeTypes).toContain('link')
  })

  it('handles large mixed documents with stable output counts', () => {
    const chunk = '月成本 **$148+ → $19** and math $a+b$ plus lone ~$1,550 then $E=mc^2$.\n\n'
    const { math, text } = parseMarkdown(chunk.repeat(2_000))
    expect(math.filter((node) => node.value === 'a+b')).toHaveLength(2_000)
    expect(math.filter((node) => node.value === 'E=mc^2')).toHaveLength(2_000)
    expect(text).toContain('$148+ → $19')
    expect(text).toContain('~$1,550')
  })
})
