import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import { toString } from 'mdast-util-to-string'
import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import type { Processor } from 'unified'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { describe, expect, it } from 'vitest'
import { remarkCurrencyAwareMath } from './remark-currency-aware-math'

const SOURCE = 'Cost $30 now $40; math $x$.'

function stockMath(this: Processor): undefined {
  const data = this.data()
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = [])
  micromarkExtensions.push(math())
  fromMarkdownExtensions.push(mathFromMarkdown())
}

function currencyAwareMathAlias(this: Processor): undefined {
  return remarkCurrencyAwareMath.call(this)
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

function isMathMdastExtension(extension: unknown): boolean {
  if (typeof extension !== 'object' || extension === null) {
    return false
  }
  const candidate = extension as { enter?: object; exit?: object }
  return (
    typeof Reflect.get(candidate.enter ?? {}, 'mathFlow') === 'function' &&
    typeof Reflect.get(candidate.enter ?? {}, 'mathText') === 'function' &&
    typeof Reflect.get(candidate.exit ?? {}, 'mathFlow') === 'function' &&
    typeof Reflect.get(candidate.exit ?? {}, 'mathText') === 'function'
  )
}

function expectCurrencyAwareResult(processor: Processor<Root>): void {
  const tree = processor.parse(SOURCE)
  const mathValues: string[] = []
  visit(tree, (node) => {
    if (node.type === 'inlineMath' || node.type === 'math') {
      mathValues.push('value' in node ? String(node.value) : '')
    }
  })
  expect(mathValues).toEqual(['x'])
  expect(toString(tree)).toBe('Cost $30 now $40; math x.')

  const data = processor.data()
  expect(data.micromarkExtensions?.filter(isMathMicromarkExtension)).toHaveLength(1)
  expect(data.fromMarkdownExtensions?.flat().filter(isMathMdastExtension)).toHaveLength(1)
}

describe('remarkCurrencyAwareMath composition', () => {
  it('keeps configured frozen processors and their clones currency-aware', () => {
    const base = unified().use(remarkParse).use(remarkGfm).use(remarkCurrencyAwareMath).freeze()

    expectCurrencyAwareResult(base)
    expectCurrencyAwareResult(base())
    expectCurrencyAwareResult(base())
  })

  it('replaces stock math extensions in either plugin order', () => {
    const oldThenNew = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(stockMath)
      .use(remarkCurrencyAwareMath)
    const newThenOld = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkCurrencyAwareMath)
      .use(stockMath)

    expectCurrencyAwareResult(oldThenNew)
    expectCurrencyAwareResult(newThenOld)
  })

  it('does not recurse or duplicate extensions when composed through an alias', () => {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkCurrencyAwareMath)
      .use(currencyAwareMathAlias)
      .use(stockMath)

    expectCurrencyAwareResult(processor)
    expectCurrencyAwareResult(processor)
  })

  it('preserves non-math extension ordering when later plugins replace the arrays', () => {
    const beforeMicromark = {}
    const afterMicromark = {}
    const beforeMdast = {}
    const afterMdast = {}
    const replaceExtensions = function (this: Processor): undefined {
      const data = this.data()
      data.micromarkExtensions = [beforeMicromark, math(), afterMicromark]
      data.fromMarkdownExtensions = [beforeMdast, mathFromMarkdown(), afterMdast]
    }
    const processor = unified().use(remarkParse).use(remarkCurrencyAwareMath).use(replaceExtensions)

    expectCurrencyAwareResult(processor)
    const data = processor.data()
    expect(
      data.micromarkExtensions?.filter((extension) => !isMathMicromarkExtension(extension))
    ).toEqual([beforeMicromark, afterMicromark])
    expect(
      data.fromMarkdownExtensions?.flat().filter((extension) => !isMathMdastExtension(extension))
    ).toEqual([beforeMdast, afterMdast])
  })
})
