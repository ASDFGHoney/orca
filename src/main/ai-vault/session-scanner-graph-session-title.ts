import { cloneSessionAccumulator } from './session-scanner-accumulator'
import type { SessionAccumulator } from './session-scanner-types'
import { extractString, normalizeTitleText } from './session-scanner-values'

export type GraphSessionTitleSource = 'user' | 'auto'

export type GraphSessionTitleState = {
  accumulator: SessionAccumulator
  source: GraphSessionTitleSource | null
}

export function cloneGraphSessionTitleState(state: GraphSessionTitleState): GraphSessionTitleState {
  return {
    accumulator: cloneSessionAccumulator(state.accumulator),
    source: state.source
  }
}

// Why: Pi `/name` and OMP `/rename` persist as harness metadata, not as the
// first user prompt. A later user title must replace auto/prompt titles, and
// an automatic title must never clobber a user title.
export function applyGraphSessionTitle(
  state: GraphSessionTitleState,
  record: Record<string, unknown>
): void {
  const incoming = graphSessionTitleFromRecord(record)
  if (!incoming) {
    return
  }
  if (state.source === 'user' && incoming.source !== 'user') {
    return
  }
  state.accumulator.title = incoming.title
  state.source = incoming.source
}

function graphSessionTitleFromRecord(
  record: Record<string, unknown>
): { title: string; source: GraphSessionTitleSource } | null {
  const type = extractString(record.type)
  if (type === 'session_info') {
    const title = normalizeTitleText(
      extractString(record.name) ?? extractString(record.title) ?? ''
    )
    return title ? { title, source: 'user' } : null
  }
  if (type !== 'title' && type !== 'title_change' && type !== 'session') {
    return null
  }
  const title = normalizeTitleText(extractString(record.title) ?? '')
  if (!title) {
    return null
  }
  const raw = extractString(record.source) ?? extractString(record.titleSource)
  return { title, source: raw === 'user' ? 'user' : 'auto' }
}
