import { toString } from 'mdast-util-to-string'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { describe, expect, it } from 'vitest'
import { remarkCurrencyAwareMath } from './remark-currency-aware-math'

function parse(source: string): { links: string[]; math: string[]; text: string } {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCurrencyAwareMath)
  const tree = processor.parse(source)
  const links: string[] = []
  const math: string[] = []
  visit(tree, (node) => {
    if (node.type === 'link') {
      links.push(node.url)
    } else if (node.type === 'inlineMath' || node.type === 'math') {
      math.push(node.value)
    }
  })
  return { links, math, text: toString(tree) }
}

describe('remarkCurrencyAwareMath parser regressions', () => {
  it('keeps currency inside a link label from consuming later math', () => {
    const source = '[price $10 to $20](https://example.test?q=1) then $x$'
    expect(parse(source)).toEqual({
      links: ['https://example.test?q=1'],
      math: ['x'],
      text: 'price $10 to $20 then x'
    })
  })

  it('renders malformed escaped code input without restoration failures', () => {
    const source = '$`$`$\\$($`'
    expect(parse(source)).toEqual({ links: [], math: ['`'], text: '`$\\$($' })
  })
})
