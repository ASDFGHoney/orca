import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import { toString } from 'mdast-util-to-string'
import type { Root } from 'mdast'
import type { Code, Construct, State, TokenType } from 'micromark-util-types'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import type { Processor } from 'unified'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { describe, expect, it } from 'vitest'
import { remarkCurrencyAwareMath } from './remark-currency-aware-math'

const SOURCE = 'Cost $30 now $40; math $x$.'
const COMPOUND_SOURCE = 'before @@ after $x$; cost $10 to $20'
const COMPOUND_AT = 'compoundAt' as TokenType

const compoundAt: Construct = {
  name: 'compoundAt',
  tokenize(effects, ok, nok) {
    return start

    function start(code: Code): State | undefined {
      if (code !== 64) {
        return nok(code)
      }
      effects.enter(COMPOUND_AT)
      effects.consume(code)
      return close
    }

    function close(code: Code): State | undefined {
      if (code !== 64) {
        return nok(code)
      }
      effects.consume(code)
      effects.exit(COMPOUND_AT)
      return ok
    }
  }
}

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

function compoundMath(this: Processor): undefined {
  const micromarkExtension = math()
  micromarkExtension.text = { ...micromarkExtension.text, 64: compoundAt }
  const mdastExtension = mathFromMarkdown()
  mdastExtension.enter = {
    ...mdastExtension.enter,
    compoundAt(token) {
      this.enter({ type: 'text', value: 'CUSTOM' }, token)
    }
  }
  mdastExtension.exit = {
    ...mdastExtension.exit,
    compoundAt(token) {
      this.exit(token)
    }
  }
  const data = this.data()
  const micromarkExtensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  const fromMarkdownExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = [])
  micromarkExtensions.push(micromarkExtension)
  fromMarkdownExtensions.push(mdastExtension)
}

function containsConstruct(value: unknown, name: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsConstruct(item, name))
  }
  if (typeof value !== 'object' || value === null || !('name' in value)) {
    return false
  }
  return value.name === name
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

  it('preserves unrelated syntax bundled with replaced stock math', () => {
    const processors = [
      unified().use(remarkParse).use(compoundMath).use(remarkCurrencyAwareMath).freeze(),
      unified().use(remarkParse).use(remarkCurrencyAwareMath).use(compoundMath).freeze()
    ]

    for (const base of processors) {
      for (const processor of [base, base()]) {
        const tree = processor.parse(COMPOUND_SOURCE)
        expect(toString(tree)).toBe('before CUSTOM after x; cost $10 to $20')
        expect(
          processor.data().micromarkExtensions?.some((extension) => extension.text?.[64])
        ).toBe(true)
        expect(
          processor
            .data()
            .fromMarkdownExtensions?.flat()
            .some((extension) => typeof extension.enter?.compoundAt === 'function')
        ).toBe(true)
        expect(processor.data().micromarkExtensions?.filter(isMathMicromarkExtension)).toHaveLength(
          1
        )
        expect(
          processor.data().fromMarkdownExtensions?.flat().filter(isMathMdastExtension)
        ).toHaveLength(1)
      }
    }
  })
})
