import { escapeMarkdownLinkDestination } from './adf-media-destination'

type JiraAdfRecord = Record<string, unknown>

function asRecord(value: unknown): JiraAdfRecord {
  return value && typeof value === 'object' ? (value as JiraAdfRecord) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Escape characters that would break a Markdown link label. */
export function escapeMarkdownLinkLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

function markType(mark: unknown): string {
  return asString(asRecord(mark).type)
}

function linkHrefFromMarks(marks: unknown[]): string | undefined {
  for (const mark of marks) {
    if (markType(mark) !== 'link') {
      continue
    }
    const href = asString(asRecord(asRecord(mark).attrs).href).trim()
    if (href) {
      return href
    }
  }
  return undefined
}

/**
 * Apply ADF text marks. Formatting is nested inside the link so CommonMark keeps
 * both the destination and emphasis (e.g. [**label**](url)).
 */
export function applyAdfTextMarks(text: string, marksValue: unknown): string {
  const marks = asArray(marksValue)
  if (!text || marks.length === 0) {
    return text
  }

  let formatted = text
  // Why: code spans cannot nest other Markdown; apply code before bold/em/strike.
  if (marks.some((mark) => markType(mark) === 'code')) {
    formatted = `\`${formatted.replace(/`/g, '\\`')}\``
  } else {
    if (marks.some((mark) => markType(mark) === 'strong')) {
      formatted = `**${formatted}**`
    }
    if (marks.some((mark) => markType(mark) === 'em')) {
      formatted = `*${formatted}*`
    }
    if (marks.some((mark) => markType(mark) === 'strike')) {
      formatted = `~~${formatted}~~`
    }
  }

  const href = linkHrefFromMarks(marks)
  if (!href) {
    return formatted
  }

  const safeUrl = escapeMarkdownLinkDestination(href)
  // Why: unsafe schemes must stay non-clickable text; keep visible label + marks.
  if (!safeUrl) {
    return formatted
  }

  return `[${escapeMarkdownLinkLabel(formatted)}](${safeUrl})`
}
