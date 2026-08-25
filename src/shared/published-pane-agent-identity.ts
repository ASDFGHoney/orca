import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolvePaneAgentIdentity } from './pane-agent-identity-resolver'
import type { TuiAgent } from './tui-agent'

/**
 * The agent a host publishes for a pane, for consumers that ACT on identity.
 *
 * Kept out of the runtime class so it can be tested without one, and so routing, delivery and the
 * UI all read the same decision instead of each re-deriving it.
 *
 * Hook evidence ranks first because the agent reports its own identity regardless of how it was
 * started — Orca's launcher, a shell prompt, or a resumed session — and regardless of host.
 *
 * Title is NOT consulted. What this publishes authorizes actions, and a terminal title is a
 * decoration channel a user can type any agent's name into — "Switch Claude and Codex off the
 * load balancer… - grok" is a Grok pane that used to receive both `@claude` and `@codex`.
 * Identity therefore comes only from launch and foreground-process evidence the host owns.
 *
 * Returns undefined when nothing is known, and absence is published as absence. A caller that
 * authorizes an action must fail closed on it rather than falling back to parsing the title.
 */
export function resolvePublishedPaneAgentIdentity(args: {
  /**
   * The agent a provider hook reported for this pane. The ONLY signal that does not depend on how
   * the agent was started: a user who types `claude` at a shell still posts hooks. It is also the
   * only one that survives WSL, where the Windows host reads the foreground process as `wsl.exe`
   * rather than the agent running inside the distro.
   */
  hookAgent?: TuiAgent | null
  /** Whether that hook belongs to a turn in progress, as opposed to one that finished. */
  hookIsLive?: boolean
  launchAgent?: TuiAgent | null
  foregroundAgent?: TuiAgent | null
  title?: string | null
}): TuiAgent | undefined {
  const titleAgent = args.title ? collectAgentTitleEvidence(args.title).agent : null
  return (
    resolvePaneAgentIdentity({
      // Why the floor: what this publishes authorizes actions — orchestration routing decides
      // which real agent pane receives a message. Ranking title last makes a bad delivery
      // unlikely; refusing to see it makes one impossible. A pane whose only evidence is a
      // parsed string publishes no identity, and every action consumer fails closed on absence.
      minimumSource: 'launch',
      evidence: [
        ...(args.hookAgent
          ? [
              {
                source: args.hookIsLive ? ('live-hook' as const) : ('completed-hook' as const),
                agent: args.hookAgent
              }
            ]
          : []),
        ...(args.foregroundAgent
          ? [{ source: 'process' as const, agent: args.foregroundAgent }]
          : []),
        ...(args.launchAgent ? [{ source: 'launch' as const, agent: args.launchAgent }] : []),
        ...(titleAgent ? [{ source: 'title' as const, agent: titleAgent }] : [])
      ]
    }).agent ?? undefined
  )
}
