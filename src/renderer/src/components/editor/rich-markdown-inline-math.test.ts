import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

// STA-4635 / #15100 reporter string — two unguarded `$…$` spans swallow currency and CJK prose.
const ISSUE_CURRENCY_PROSE =
  '月成本 **$148+ → $19**（省 **87%**，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'

function createEditor(content: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })
}

function parseMarkdown(content: string): {
  markdown: string
  text: string
  inlineMath: string[]
  blockMath: string[]
} {
  const editor = createEditor(content)
  try {
    const inlineMath: string[] = []
    const blockMath: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'inlineMath') {
        inlineMath.push(String(node.attrs.latex ?? ''))
      }
      if (node.type.name === 'blockMath') {
        blockMath.push(String(node.attrs.latex ?? ''))
      }
    })
    return {
      markdown: editor.getMarkdown().trimEnd(),
      text: editor.state.doc.textContent,
      inlineMath,
      blockMath
    }
  } finally {
    editor.destroy()
  }
}

describe('rich markdown inline math currency guard', () => {
  it('round-trips the reporter currency string with prose and every amount intact', () => {
    const { markdown, inlineMath } = parseMarkdown(ISSUE_CURRENCY_PROSE)

    expect(inlineMath).toEqual([])
    expect(markdown).toContain('$148')
    expect(markdown).toContain('$19')
    expect(markdown).toContain('$1,550')
    expect(markdown).toContain('$15.4')
    expect(markdown).toContain('月成本')
    expect(markdown).toContain('后续释放老 EIP')
    expect((markdown.match(/\$/g) ?? []).length).toBe(4)
  })

  it('still parses $$…$$ as display math', () => {
    const { inlineMath, blockMath, markdown } = parseMarkdown('Before\n\n$$\nx + y\n$$\n\nAfter')

    expect(inlineMath).toEqual([])
    expect(blockMath).toEqual(['x + y'])
    expect(markdown).toBe('Before\n\n$$\nx + y\n$$\n\nAfter')
  })

  it('never treats a single $ adjacent to digits as math', () => {
    expect(parseMarkdown('The price is $19.').inlineMath).toEqual([])
    expect(parseMarkdown('$148 is the monthly cost').inlineMath).toEqual([])
    expect(parseMarkdown('$148+ → $19').inlineMath).toEqual([])
    expect(parseMarkdown('costs $100$ exactly').inlineMath).toEqual([])
  })

  it('does not consume CJK prose between two currency $ signs', () => {
    const source = '~$1,550）；后续释放老 EIP 可再降到 $15.4/月'
    const { markdown, inlineMath, text } = parseMarkdown(source)

    expect(inlineMath).toEqual([])
    expect(markdown).toContain('$1,550')
    expect(markdown).toContain('$15.4')
    expect(text).toContain('后续释放老 EIP')
  })

  it('still parses genuine Pandoc inline math', () => {
    expect(parseMarkdown('Einstein wrote $E=mc^2$ in 1905.').inlineMath).toEqual(['E=mc^2'])
    expect(parseMarkdown('The variable is $x$.').inlineMath).toEqual(['x'])
    expect(parseMarkdown('Arithmetic $2+2$ is math.').inlineMath).toEqual(['2+2'])
  })
})
