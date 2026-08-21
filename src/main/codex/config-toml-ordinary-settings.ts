import { isOrcaRewrittenCodexPreambleKey } from './codex-config-path-reference-rewrite'
import { tuiStructuredKey } from './codex-config-settings-upsert'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

export type OrdinaryCodexSettingValue = {
  raw: string
  // Why: a multiline string/array value can't be replaced line-by-line, so it's excluded from promotion.
  multiline: boolean
}

// Why: these are user preferences the Codex TUI persists. Pre-registering them
// in the baseline makes the first in-Codex change promote into ~/.codex instead
// of sitting as a runtime-local conflict. Other ordinary keys carry through the
// remirror without that write-through.
export const PROMOTED_CODEX_SETTING_KEYS = [
  'model',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode'
] as const

export const PROMOTED_CODEX_TUI_SETTING_KEYS = [
  'status_line',
  'status_line_use_colors',
  'terminal_title',
  'theme'
] as const

export const PROMOTED_STRUCTURED_KEYS: readonly string[] = [
  ...PROMOTED_CODEX_SETTING_KEYS,
  ...PROMOTED_CODEX_TUI_SETTING_KEYS.map(tuiStructuredKey)
]

export function parseOrdinaryCodexSettingValues(
  content: string
): Map<string, OrdinaryCodexSettingValue> {
  const result = new Map<string, OrdinaryCodexSettingValue>()
  const lines = content.split('\n')
  let state = createTomlLineScanState()
  let inPreamble = true
  let tuiTableSeen = false
  let tuiBodyActive = false
  for (const line of lines) {
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        const table = parseTomlTableHeaderPath(header)
        tuiBodyActive =
          table !== null &&
          !table.isArray &&
          table.segments.length === 1 &&
          table.segments[0] === 'tui' &&
          !tuiTableSeen
        if (tuiBodyActive) {
          tuiTableSeen = true
        }
        inPreamble = false
        state = updateTomlLineScanState(state, line)
        continue
      }
      const matched = matchOrdinaryStructuredKey(line, inPreamble, tuiBodyActive)
      if (matched) {
        const nextState = updateTomlLineScanState(state, line)
        result.set(matched.structuredKey, {
          raw: matched.raw,
          multiline: !isTomlStructuralLine(nextState)
        })
        state = nextState
        continue
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return result
}

export function collectOrdinaryCodexSettingKeys(
  runtimeValues: ReadonlyMap<string, OrdinaryCodexSettingValue>,
  systemValues: ReadonlyMap<string, OrdinaryCodexSettingValue>,
  trackedKeys: Iterable<string>
): string[] {
  return [
    ...new Set([
      ...PROMOTED_STRUCTURED_KEYS,
      ...runtimeValues.keys(),
      ...systemValues.keys(),
      ...trackedKeys
    ])
  ]
}

function matchOrdinaryStructuredKey(
  line: string,
  inPreamble: boolean,
  tuiBodyActive: boolean
): { structuredKey: string; raw: string } | null {
  const parsed = parseTomlKeyPath(line)
  if (!parsed || line[parsed.end] !== '=') {
    return null
  }
  const raw = line.slice(parsed.end + 1).trim()
  const topLevelKey = parsed.segments.length === 1 ? parsed.segments[0] : null
  // Why: `tui = { ... }` already defines the tui table; scanning it as a scalar
  // would strand a conflict against a `[tui]` body the upsert cannot place.
  if (
    inPreamble &&
    topLevelKey &&
    topLevelKey !== 'tui' &&
    !isOrcaRewrittenCodexPreambleKey(topLevelKey)
  ) {
    return { structuredKey: topLevelKey, raw }
  }
  const tuiKey = matchTuiStructuredKey(parsed.segments, inPreamble, tuiBodyActive)
  return tuiKey ? { structuredKey: tuiKey, raw } : null
}

function matchTuiStructuredKey(
  keyPath: string[],
  inPreamble: boolean,
  tuiBodyActive: boolean
): string | null {
  if (inPreamble) {
    const tuiKey = keyPath.length === 2 && keyPath[0] === 'tui' ? keyPath[1] : null
    return tuiKey ? tuiStructuredKey(tuiKey) : null
  }
  const tuiKey = keyPath.length === 1 ? keyPath[0] : null
  return tuiBodyActive && tuiKey ? tuiStructuredKey(tuiKey) : null
}
