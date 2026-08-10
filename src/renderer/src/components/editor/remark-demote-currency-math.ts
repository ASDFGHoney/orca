/**
 * After remark-math, restore USD-style `$…$` false positives to plain text.
 * Matches the rich editor's currency guard: a closing `$` before a digit is
 * money, pure numeric spans like `$100$` are not math, and digit-led spans
 * without math structure (`$1,550 and $…`) are treated as currency prose.
 */

type MarkdownAstNode = {
  type: string
  value?: string
  data?: unknown
  children?: MarkdownAstNode[]
}

// Why: `$1,550` / `$15.4` / `$100` are currency; keep real math like `$E=mc^2$`.
const PURE_CURRENCY_AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/
// Why: operators / TeX mark real math (`$2+2$`, `$2^n$`, `$\alpha$`); currency prose lacks them.
const MATH_SIGNAL = /[\\^_={}+\-*/]/

export function isCurrencyLikeMathValue(value: string): boolean {
  if (PURE_CURRENCY_AMOUNT.test(value)) {
    return true
  }
  // Digit-led span without math structure → currency / prose, not formula.
  return /^\d/u.test(value) && !MATH_SIGNAL.test(value)
}

export function isCurrencyFalsePositiveInlineMath(
  node: MarkdownAstNode,
  nextNode: MarkdownAstNode | undefined
): boolean {
  if (node.type !== 'inlineMath' || node.value === undefined) {
    return false
  }

  // Closing `$` was immediately followed by a digit (`$148+ → $19`).
  if (nextNode?.type === 'text' && nextNode.value !== undefined && /^\d/u.test(nextNode.value)) {
    return true
  }

  return isCurrencyLikeMathValue(node.value)
}

/**
 * When currency demotion used a later `$` as its closer, the following text may
 * still hold a real formula as `E=mc^2$`. Promote that leftover back to math.
 */
export function recoverTrailingInlineMathFromText(value: string): MarkdownAstNode[] | undefined {
  const match = /^([\s\S]*?)\$(?!\$)/u.exec(value)
  if (match === null) {
    return undefined
  }

  const latex = match[1]
  if (latex.length === 0 || isCurrencyLikeMathValue(latex) || !MATH_SIGNAL.test(latex)) {
    return undefined
  }

  const rest = value.slice(match[0].length)
  const nodes: MarkdownAstNode[] = [{ type: 'inlineMath', value: latex }]
  if (rest.length > 0) {
    nodes.push({ type: 'text', value: rest })
  }
  return nodes
}

function demoteCurrencyFalsePositiveMath(node: MarkdownAstNode): void {
  const children = node.children
  if (children === undefined) {
    return
  }

  const nextChildren: MarkdownAstNode[] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    const nextNode = children[index + 1]

    if (!isCurrencyFalsePositiveInlineMath(child, nextNode)) {
      demoteCurrencyFalsePositiveMath(child)
      nextChildren.push(child)
      continue
    }

    // Why: if the closer was really the next formula's opener, restore only the leading `$`.
    const recovered =
      nextNode?.type === 'text' && nextNode.value !== undefined
        ? recoverTrailingInlineMathFromText(nextNode.value)
        : undefined

    nextChildren.push({
      type: 'text',
      value: recovered !== undefined ? `$${child.value}` : `$${child.value}$`
    })

    if (recovered !== undefined) {
      nextChildren.push(...recovered)
      index += 1
    }
  }

  node.children = nextChildren
}

export function remarkDemoteCurrencyMath(): (tree: MarkdownAstNode) => void {
  return (tree) => {
    demoteCurrencyFalsePositiveMath(tree)
  }
}
