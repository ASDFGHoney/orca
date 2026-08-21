export function linearListTruncationLine(returned: number, truncated: boolean): string | null {
  return truncated ? `truncated: showing ${returned}` : null
}

export function appendLinearListTruncation(
  body: string,
  returned: number,
  truncated: boolean
): string {
  const line = linearListTruncationLine(returned, truncated)
  return line ? `${body}\n${line}` : body
}
