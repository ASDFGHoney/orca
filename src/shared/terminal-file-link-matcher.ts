export type TerminalFileLinkTarget = {
  pathText: string
  line: number | null
  column: number | null
}

export type TerminalFileLinkMatch = TerminalFileLinkTarget & {
  startIndex: number
  endIndex: number
}

const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g
const SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

type TextRange = { text: string; startIndex: number; endIndex: number }

export function parseTerminalFileLinkTarget(value: string): TerminalFileLinkTarget | null {
  const parsed = parseFileLinkLocation(value)
  if (!parsed || parsed.pathText.endsWith('/') || parsed.pathText.endsWith('\\')) {
    return null
  }
  return parsed
}

export function findTerminalFileLinks(lineText: string): TerminalFileLinkMatch[] {
  const links: TerminalFileLinkMatch[] = []
  SPACED_PATH_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPACED_PATH_REGEX.exec(lineText)) !== null) {
    const trimmed = trimBoundaryPunctuation(match[0], match.index)
    if (
      !trimmed ||
      (!hasSeparatorAfterWhitespace(trimmed.text) && !hasSpacedPathExtension(trimmed.text))
    ) {
      continue
    }
    addParsedLink(links, trimSpacedPathTrailingProse(trimmed), false)
  }

  LOCAL_PATH_REGEX.lastIndex = 0
  while ((match = LOCAL_PATH_REGEX.exec(lineText)) !== null) {
    if (match[0].length === 0) {
      LOCAL_PATH_REGEX.lastIndex += 1
      continue
    }
    addParsedLink(links, trimBoundaryPunctuation(match[0], match.index), true)
  }
  return links.sort(
    (left, right) => left.startIndex - right.startIndex || right.endIndex - left.endIndex
  )
}

export function matchTerminalFileLinkAtColumn(
  lineText: string,
  column: number
): TerminalFileLinkTarget | null {
  const match = findTerminalFileLinks(lineText).find(
    (candidate) => column >= candidate.startIndex && column < candidate.endIndex
  )
  return match ? { pathText: match.pathText, line: match.line, column: match.column } : null
}

function addParsedLink(
  links: TerminalFileLinkMatch[],
  range: TextRange | null,
  rejectOverlap: boolean
): void {
  if (
    !range ||
    (rejectOverlap &&
      links.some((link) => range.startIndex < link.endIndex && range.endIndex > link.startIndex))
  ) {
    return
  }
  const parsed = parseTerminalFileLinkTarget(range.text)
  if (!parsed) {
    return
  }
  links.push({ ...parsed, startIndex: range.startIndex, endIndex: range.endIndex })
}

function trimBoundaryPunctuation(value: string, startIndex: number): TextRange | null {
  let start = 0
  let end = value.length
  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }
  return start < end
    ? {
        text: value.slice(start, end),
        startIndex: startIndex + start,
        endIndex: startIndex + end
      }
    : null
}

function hasSeparatorAfterWhitespace(text: string): boolean {
  let sawWhitespace = false
  for (const character of text) {
    if (/\s/.test(character)) {
      sawWhitespace = true
    } else if (sawWhitespace && (character === '/' || character === '\\')) {
      return true
    }
  }
  return false
}

function trimSpacedPathTrailingProse(range: TextRange): TextRange | null {
  let selected: string | null = null
  const extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  let match: RegExpExecArray | null
  while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    const text = range.text.slice(0, end)
    if (countPathStarts(text) > 1) {
      continue
    }
    if (
      end < range.text.length ||
      selected === null ||
      /[\\/]/.test(range.text.slice(selected.length, end))
    ) {
      selected = text
    }
  }
  if (selected === null && countPathStarts(range.text) > 1) {
    return null
  }
  const text = selected ?? range.text.trimEnd()
  return text
    ? {
        text,
        startIndex: range.startIndex,
        endIndex: range.startIndex + text.length
      }
    : null
}

function countPathStarts(text: string): number {
  let count = 0
  for (const match of text.matchAll(/(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g)) {
    void match
    count += 1
  }
  return count
}

function hasSpacedPathExtension(text: string): boolean {
  const trimmed = trimSpacedPathTrailingProse({
    text,
    startIndex: 0,
    endIndex: text.length
  })?.text
  return Boolean(
    trimmed && /\s/.test(trimmed) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmed)
  )
}
import { parseFileLinkLocation } from './file-link-location'
