import { fromMarkdown, type Options as FromMarkdownOptions } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'

export type MarkdownSourceRange = { end: number; start: number }
export type MarkdownTextScope = MarkdownSourceRange[]
export type MarkdownTextAnalysis = {
  decodedCharacters: Set<string>
  scopes: MarkdownTextScope[]
}

const TEXT_SCOPE_TYPES = new Set(['heading', 'paragraph', 'tableCell'])

function collectTextRanges(
  node: Nodes,
  source: string,
  insideAutolink: boolean,
  decodedCharacters: Set<string>
): MarkdownSourceRange[] {
  const start = node.position?.start.offset
  const autolink =
    insideAutolink || (node.type === 'link' && start !== undefined && source[start] !== '[')
  if (node.type === 'text') {
    for (const character of node.value) {
      decodedCharacters.add(character)
    }
    const end = node.position?.end.offset
    return autolink || start === undefined || end === undefined ? [] : [{ start, end }]
  }
  if (!('children' in node)) {
    return []
  }
  return node.children.flatMap((child) =>
    collectTextRanges(child, source, autolink, decodedCharacters)
  )
}

export function analyzeMarkdownTextScopes(
  source: string,
  options: FromMarkdownOptions
): MarkdownTextAnalysis {
  const tree = fromMarkdown(source, options)
  const scopes: MarkdownTextScope[] = []
  const decodedCharacters = new Set<string>()
  const visitNode = (node: Nodes): void => {
    if (TEXT_SCOPE_TYPES.has(node.type)) {
      const ranges = collectTextRanges(node, source, false, decodedCharacters)
      if (ranges.length > 0) {
        scopes.push(ranges)
      }
      return
    }
    if ('children' in node) {
      node.children.forEach(visitNode)
    }
  }
  visitNode(tree)
  return { decodedCharacters, scopes }
}
