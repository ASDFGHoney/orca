import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { parsePaneKey } from './stable-pane-id'

export function remoteCodexHookStartupProps(
  recognized: boolean,
  agentEnv: Record<string, string> | null | undefined
) {
  return {
    ...(recognized ? { startupCommandDelivery: 'shell-ready' as const } : {}),
    ...(agentEnv ? { env: { ...agentEnv } } : {})
  }
}

function isCodexExecutable(token: string): boolean {
  return token === 'codex'
}

function isPosixEnvAssignment(
  command: string,
  span: { start: number; end: number; divergesFromShell: boolean }
): boolean {
  return (
    !span.divergesFromShell && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(span.start, span.end))
  )
}

function hasOnlyHorizontalWhitespaceGaps(
  command: string,
  spans: readonly { start: number; end: number }[]
): boolean {
  let previousEnd = 0
  for (const span of spans) {
    if (!/^[\t ]*$/.test(command.slice(previousEnd, span.start))) {
      return false
    }
    previousEnd = span.end
  }
  return /^[\t ]*$/.test(command.slice(previousEnd))
}

function isDirectCodexCommand(
  command: string,
  tokenized: Extract<ReturnType<typeof tokenizeStartupCommand>, { ok: true }>
): boolean {
  const codexIndex = tokenized.tokens.findIndex(isCodexExecutable)
  const codexSpan = tokenized.spans[codexIndex]
  return (
    codexIndex !== -1 &&
    codexSpan !== undefined &&
    command.slice(codexSpan.start, codexSpan.end) === 'codex' &&
    tokenized.spans.slice(0, codexIndex).every((span) => isPosixEnvAssignment(command, span)) &&
    tokenized.spans.every((span) => !span.divergesFromShell) &&
    hasOnlyHorizontalWhitespaceGaps(command, tokenized.spans)
  )
}

export function hasCompleteRemoteAgentHookContext(args: {
  env: Record<string, string>
  paneKey: unknown
}): boolean {
  const paneKey = typeof args.paneKey === 'string' ? args.paneKey : ''
  return Boolean(
    args.env.ORCA_AGENT_HOOK_PORT?.trim() &&
    args.env.ORCA_AGENT_HOOK_TOKEN?.trim() &&
    paneKey &&
    args.env.ORCA_PANE_KEY === paneKey &&
    parsePaneKey(paneKey)
  )
}

/** Recognizes direct remote POSIX Codex commands without rewriting them. */
export function isDirectRemotePosixCodexLaunch(args: {
  agent: TuiAgent
  command: string
  shell: AgentStartupShell
  isRemote?: boolean
}): boolean {
  if (args.agent !== 'codex' || args.isRemote !== true || args.shell !== 'posix') {
    return false
  }
  const tokenized = tokenizeStartupCommand(args.command, args.shell)
  return tokenized.ok && isDirectCodexCommand(args.command, tokenized)
}
