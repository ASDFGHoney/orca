import {
  AGY_AGENT_NAME_RE,
  CLAUDE_IDLE,
  DROID_AGENT_NAME_RE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  HERMES_AGENT_NAME_RE,
  isClaudeManagementTitle,
  isCursorNativeAgentTitle,
  titleHasAgentName
} from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import { getPiCompatibleSyntheticAgentLabel } from './pi-compatible-synthetic-title'
import type { TuiAgent } from './tui-agent'

/**
 * Order-independent identity evidence from a terminal title.
 *
 * The chain this replaces is a first-match-wins scan of substring predicates, so its answer is
 * decided by list position rather than by how strong the evidence is. That is why a Grok pane
 * whose task text mentions Codex reads as Codex, and why fixing one collision by hoisting a
 * branch breaks another. Here every signal is collected first and ranked afterwards, by class:
 *
 *   vendor marker  — a control sequence or sigil the agent itself emits. Task text cannot forge it.
 *   anchored name  — a name in a position some grammar reserves for identity (Orca's `- <agent>`
 *                    owner suffix, or the whole undecorated remainder).
 *   free-text name — a name anywhere else. Anyone can type it.
 *
 * A free-text name never becomes identity on its own, even when it is the only name present: an
 * absent icon is recoverable, a confidently wrong one is not. Callers that only need "is this pane
 * busy" want activity parsing, which lives elsewhere and does not go through here.
 */
export type AgentTitleEvidenceReason =
  | 'anchored'
  | 'vendor-marker'
  | 'conflicting-anchored-names'
  | 'conflicting-vendor-markers'
  | 'free-text-only'
  | 'no-evidence'

export type AgentTitleEvidence = {
  readonly vendorMarkers: readonly TuiAgent[]
  readonly anchoredNames: readonly TuiAgent[]
  readonly freeTextNames: readonly TuiAgent[]
  /** Null whenever the title cannot answer on its own. Callers fall back to stronger signals. */
  readonly agent: TuiAgent | null
  readonly reason: AgentTitleEvidenceReason
}

/** Names matched as whole tokens, paired with the agent each identifies. */
const NAME_TOKENS: readonly (readonly [string, TuiAgent])[] = [
  ['claude', 'claude'],
  ['openclaude', 'openclaude'],
  ['codex', 'codex'],
  ['copilot', 'copilot'],
  ['cursor', 'cursor'],
  ['gemini', 'gemini'],
  ['antigravity', 'antigravity'],
  ['opencode', 'opencode'],
  ['mimo', 'mimo-code'],
  ['openclaw', 'openclaw'],
  ['aider', 'aider'],
  ['grok', 'grok'],
  ['devin', 'devin']
]

/** Agents whose name is matched by a dedicated pattern rather than a plain token. */
const PATTERN_NAMES: readonly (readonly [RegExp, TuiAgent])[] = [
  [AGY_AGENT_NAME_RE, 'antigravity'],
  [DROID_AGENT_NAME_RE, 'droid'],
  [HERMES_AGENT_NAME_RE, 'hermes']
]

/**
 * Canonical display labels an agent may write as its whole title. Declared here rather than
 * derived from the renderer catalog so this module stays free of UI-layer imports; the labels an
 * agent actually emits are a title fact, not a presentation choice.
 */
const DISPLAY_LABELS: readonly (readonly [string, TuiAgent])[] = [
  ['claude code', 'claude'],
  ['gemini cli', 'gemini'],
  ['mimo code', 'mimo-code'],
  ['github copilot', 'copilot'],
  ['command code', 'command-code'],
  ['prime agent', 'prime-agent'],
  ['agent teams', 'claude-agent-teams']
]

const GEMINI_GLYPHS = [GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION]

/**
 * Orca renders `<task text>… - <agent>` and owns the suffix; task text cannot reach past it.
 * Why leading whitespace is required: without it this also matches the tail of a hyphenated
 * worktree name (`review-14600-codex`), which is a directory, not an owner declaration.
 */
const OWNER_SUFFIX_RE = /\s-\s+([A-Za-z][\w-]*)\s*$/

function namesIn(text: string): TuiAgent[] {
  const found = new Set<TuiAgent>()
  for (const [token, agent] of NAME_TOKENS) {
    if (titleHasAgentName(text, token)) {
      found.add(agent)
    }
  }
  for (const [pattern, agent] of PATTERN_NAMES) {
    if (pattern.test(text)) {
      found.add(agent)
    }
  }
  return [...found]
}

function agentForBareName(text: string): TuiAgent | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  const names = namesIn(trimmed)
  if (names.length !== 1) {
    return null
  }
  // Why the length check: the remainder must BE the name, not merely contain it. "agy" anchors;
  // "fix the agy hook" does not, and neither does a hyphenated worktree name like "codex-split".
  const stripped = trimmed.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')
  if (/^[\p{L}\p{N}]+$/u.test(stripped)) {
    return names[0]
  }
  // Why labels too: an agent may write its own display name as the entire title (`⠐ Claude Code`).
  // That is the same claim as a bare token, just spelled the way the vendor spells it.
  const label = DISPLAY_LABELS.find(([text]) => text === stripped.toLowerCase())
  return label ? label[1] : null
}

function collectVendorMarkers(title: string): TuiAgent[] {
  const markers = new Set<TuiAgent>()
  // Why prefix-only for Claude: the sigil marks the pane's own status line. The same character
  // inside task text is decoration, not a vendor emission.
  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    markers.add('claude')
  }
  if (GEMINI_GLYPHS.some((glyph) => title.includes(glyph))) {
    markers.add('gemini')
  }
  if (isCursorNativeAgentTitle(title)) {
    markers.add('cursor')
  }
  return [...markers]
}

function collectAnchoredNames(title: string): TuiAgent[] {
  const anchored = new Set<TuiAgent>()

  // Why anchored and not a bare marker: the native envelope owns the whole title. Its session
  // text routinely names other agents ("OC | QA the Cursor sidecar") without ceasing to be
  // OpenCode, so a foreign name in that text must not be able to veto it.
  if (isOpenCodeNativeTitle(title)) {
    anchored.add('opencode')
  }

  const suffix = OWNER_SUFFIX_RE.exec(title)
  if (suffix) {
    const agent = agentForBareName(suffix[1])
    if (agent) {
      anchored.add(agent)
    }
  }

  // Why strip a leading vendor sigil first: `✳ agy` is a Claude-glyphed pane whose entire
  // remainder is another agent's name — the strongest name evidence a title can carry.
  const withoutSigil = title.startsWith(`${CLAUDE_IDLE} `) ? title.slice(CLAUDE_IDLE.length) : title
  const bare = agentForBareName(withoutSigil)
  if (bare) {
    anchored.add(bare)
  }

  // Why Antigravity gets a grammar: its models are named `Gemini <n.n> <Name>`, so an agy pane's
  // own title carries a whole `gemini` token. Read as identity-plus-model, the gemini token is
  // metadata — which is the general rule, not an exception inside the Gemini detector.
  if (AGY_AGENT_NAME_RE.test(title) || titleHasAgentName(title, 'antigravity')) {
    if (/\bgemini\s+\d/i.test(title)) {
      anchored.add('antigravity')
    }
  }

  const piCompatible = getPiCompatibleSyntheticAgentLabel(title)
  if (piCompatible === 'Pi') {
    anchored.add('pi')
  } else if (piCompatible === 'OMP') {
    anchored.add('omp')
  }

  return [...anchored]
}

/** Collects every identity signal in `title` and ranks them by class, never by declaration order. */
export function collectAgentTitleEvidence(title: string): AgentTitleEvidence {
  const empty = { vendorMarkers: [], anchoredNames: [], freeTextNames: [] } as const
  if (!title.trim() || isClaudeManagementTitle(title)) {
    // Why: a `claude agents` management screen is Claude's own UI, not an agent session.
    return { ...empty, agent: null, reason: 'no-evidence' }
  }

  const vendorMarkers = collectVendorMarkers(title)
  const anchoredNames = collectAnchoredNames(title)
  const anchoredSet = new Set(anchoredNames)
  const freeTextNames = namesIn(title).filter((agent) => !anchoredSet.has(agent))
  const evidence = { vendorMarkers, anchoredNames, freeTextNames } as const

  if (anchoredNames.length === 1) {
    // Why anchored beats a vendor marker: `✳ agy` is an agy pane whose title kept Claude's sigil.
    return { ...evidence, agent: anchoredNames[0], reason: 'anchored' }
  }
  if (anchoredNames.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-anchored-names' }
  }
  if (vendorMarkers.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-vendor-markers' }
  }
  if (vendorMarkers.length === 1) {
    // Why free text does not veto here: `✳ Fix Codex false attention notifications` is a Claude
    // pane describing Codex work. The sigil is emitted by the agent; the name was typed by a
    // human. A conflicting ANCHORED name already outranks this branch above, which is what makes
    // `✳ agy` resolve to Antigravity without also blinding the 13 recorded titles of this shape.
    return { ...evidence, agent: vendorMarkers[0], reason: 'vendor-marker' }
  }
  return {
    ...evidence,
    agent: null,
    reason: freeTextNames.length > 0 ? 'free-text-only' : 'no-evidence'
  }
}
