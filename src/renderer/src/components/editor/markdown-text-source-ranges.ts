import { fromMarkdown, type Options as FromMarkdownOptions } from 'mdast-util-from-markdown'
import { parse, postprocess, preprocess } from 'micromark'
import type { Nodes } from 'mdast'

export type MarkdownSourceRange = { end: number; start: number }
export type MarkdownTextScope = MarkdownSourceRange[]
export type MarkdownTextAnalysis = {
  decodedCharacters: Set<string>
  scopes: MarkdownTextScope[]
}

const TEXT_SCOPE_TYPES = new Set(['heading', 'paragraph', 'tableCell'])

function addDecodedCharacters(value: string, decodedCharacters: Set<string>): void {
  for (const character of value) {
    decodedCharacters.add(character)
  }
}

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
    addDecodedCharacters(node.value, decodedCharacters)
    const end = node.position?.end.offset
    return autolink || start === undefined || end === undefined ? [] : [{ start, end }]
  }
  if (node.type === 'image' || node.type === 'imageReference') {
    addDecodedCharacters(node.alt ?? '', decodedCharacters)
  }
  if (!('children' in node)) {
    return []
  }
  return node.children.flatMap((child) =>
    collectTextRanges(child, source, autolink, decodedCharacters)
  )
}

function collectImageLabelScopes(
  source: string,
  options: FromMarkdownOptions
): MarkdownTextScope[] {
  const events = postprocess(
    parse({ extensions: options.extensions })
      .document()
      .write(preprocess()(source, undefined, true))
  )
  const scopes: MarkdownTextScope[] = []
  let imageRanges: MarkdownSourceRange[] | undefined
  let insideLabelText = false
  for (const [kind, token] of events) {
    if (kind === 'enter' && token.type === 'image') {
      imageRanges = []
    } else if (kind === 'enter' && token.type === 'labelText') {
      insideLabelText = true
    } else if (kind === 'enter' && token.type === 'data' && insideLabelText) {
      const start = token.start.offset
      const end = token.end.offset
      if (imageRanges !== undefined && start !== undefined && end !== undefined) {
        imageRanges.push({ start, end })
      }
    } else if (kind === 'exit' && token.type === 'labelText') {
      insideLabelText = false
    } else if (kind === 'exit' && token.type === 'image') {
      if (imageRanges !== undefined && imageRanges.length > 0) {
        scopes.push(imageRanges)
      }
      imageRanges = undefined
    }
  }
  return scopes
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
  if (source.includes('![')) {
    scopes.push(...collectImageLabelScopes(source, options))
  }
  return { decodedCharacters, scopes }
}
