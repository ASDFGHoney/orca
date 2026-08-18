import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'

import { getTerminalContent } from './terminal'

export const STA4746_PROBE = 'STA4746PROBE'

// Why `;;`: values are absolute paths, so a separator that cannot appear in one
// keeps parsing exact. `toContain` on a whole path would accept a sibling
// directory that merely has the expected path as a prefix.
const FIELD_SEPARATOR = ';;'

export type Sta4746Probe = Record<string, string>

export function sta4746ProbeCommand(phase: string, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    pwd: '"$PWD"',
    oldpwd: '"$OLDPWD"',
    wt: '"$ORCA_WORKTREE_ID"',
    root: '"$ORCA_WORKSPACE_ROOT"',
    ...extra
  }
  const keys = Object.keys(fields)
  const format = keys.map((key) => `${FIELD_SEPARATOR}${key}=%s`).join('')
  const args = keys.map((key) => fields[key]).join(' ')
  return `printf '${STA4746_PROBE}${FIELD_SEPARATOR}phase=${phase}${format}\\n' ${args}`
}

function parseProbeLine(line: string): Sta4746Probe {
  const fields: Sta4746Probe = {}
  for (const chunk of line.split(FIELD_SEPARATOR)) {
    const separator = chunk.indexOf('=')
    if (separator > 0) {
      fields[chunk.slice(0, separator).trim()] = chunk.slice(separator + 1).trim()
    }
  }
  return fields
}

export async function readSta4746Probe(page: Page, phase: string): Promise<Sta4746Probe> {
  let probe: Sta4746Probe | null = null
  await expect
    .poll(
      async () => {
        const line = (await getTerminalContent(page, 12_000))
          .split('\n')
          .toReversed()
          .find(
            (candidate) =>
              candidate.includes(`${STA4746_PROBE}${FIELD_SEPARATOR}phase=${phase}`) &&
              !candidate.includes('printf')
          )
        probe = line ? parseProbeLine(line) : null
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
