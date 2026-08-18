import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'

import { stripAnsiEscapeSequences } from '../../../src/shared/ansi-escape-sequences'
import { getTerminalContent } from './terminal'

export const STA4746_PROBE = 'STA4746PROBE'

// Why `;;`: values are absolute paths, so a separator that cannot appear in one
// keeps parsing exact. `toContain` on a whole path would accept a sibling
// directory that merely has the expected path as a prefix.
const FIELD_SEPARATOR = ';;'
// Why a terminating field: a narrow terminal wraps the probe line, so a read can
// catch it half-rendered. Refusing anything without `end=1` keeps a truncated
// value from being asserted as the real cwd.
const END_FIELD = 'end'

export type Sta4746Probe = Record<string, string>

export function sta4746ProbeCommand(phase: string, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    pwd: '"$PWD"',
    oldpwd: '"$OLDPWD"',
    wt: '"$ORCA_WORKTREE_ID"',
    root: '"$ORCA_WORKSPACE_ROOT"',
    ...extra,
    [END_FIELD]: '1'
  }
  const keys = Object.keys(fields)
  const format = keys.map((key) => `${FIELD_SEPARATOR}${key}=%s`).join('')
  const args = keys.map((key) => fields[key]).join(' ')
  return `printf '${STA4746_PROBE}${FIELD_SEPARATOR}phase=${phase}${format}\\n' ${args}`
}

function parseProbeSegment(segment: string): Sta4746Probe {
  const fields: Sta4746Probe = {}
  for (const chunk of segment.split(FIELD_SEPARATOR)) {
    const separator = chunk.indexOf('=')
    if (separator > 0) {
      fields[chunk.slice(0, separator).trim()] = chunk.slice(separator + 1).trim()
    }
  }
  return fields
}

function findProbe(content: string, phase: string): Sta4746Probe | null {
  const head = `${STA4746_PROBE}${FIELD_SEPARATOR}phase=${phase}`
  // Why: xterm reflow leaves cursor-motion sequences inside the rendered row,
  // so a wrapped path arrives as `<path>ESC[1BESC[29D` and exact compares fail.
  const stripped = stripAnsiEscapeSequences(content)
  // Second pass with rows joined: a hard wrap can split the line into two rows.
  for (const candidate of [stripped, stripped.replaceAll('\n', '')]) {
    const start = candidate.lastIndexOf(head)
    if (start === -1) {
      continue
    }
    const segment = candidate.slice(start).split('\n')[0] ?? ''
    const fields = parseProbeSegment(segment)
    if (fields[END_FIELD] === '1') {
      return fields
    }
  }
  return null
}

export async function readSta4746Probe(page: Page, phase: string): Promise<Sta4746Probe> {
  let probe: Sta4746Probe | null = null
  await expect
    .poll(
      async () => {
        probe = findProbe(await getTerminalContent(page, 12_000), phase)
        return probe?.pwd ?? ''
      },
      { timeout: 90_000, message: `probe line for phase ${phase} never rendered` }
    )
    .not.toBe('')
  if (!probe) {
    throw new Error(`probe for phase ${phase} did not parse`)
  }
  console.log(`[sta4746] ${phase}: ${JSON.stringify(probe)}`)
  return probe
}
