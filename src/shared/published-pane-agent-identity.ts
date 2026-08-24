import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolvePaneAgentIdentity } from './pane-agent-identity-resolver'
import type { TuiAgent } from './tui-agent'

/**
 * The agent a host publishes for a pane, for consumers that ACT on identity.
 *
 * Kept out of the runtime class so it can be tested without one, and so routing, delivery and the
 * UI all read the same decision instead of each re-deriving it.
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
        ...(args.foregroundAgent
          ? [{ source: 'process' as const, agent: args.foregroundAgent }]
          : []),
        ...(args.launchAgent ? [{ source: 'launch' as const, agent: args.launchAgent }] : []),
        ...(titleAgent ? [{ source: 'title' as const, agent: titleAgent }] : [])
      ]
    }).agent ?? undefined
  )
}
