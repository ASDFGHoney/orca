import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

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

function isPosixEnvAssignment(command: string, span: { start: number; end: number }): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(span.start, span.end))
}

function isDirectCodexCommand(
  command: string,
  tokenized: Extract<ReturnType<typeof tokenizeStartupCommand>, { ok: true }>
): boolean {
  const codexIndex = tokenized.tokens.findIndex(isCodexExecutable)
  return (
    codexIndex !== -1 &&
    tokenized.spans.slice(0, codexIndex).every((span) => isPosixEnvAssignment(command, span)) &&
    !tokenized.spans[codexIndex]?.divergesFromShell
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
