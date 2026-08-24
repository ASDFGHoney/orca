import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolvePaneAgentIdentity } from './pane-agent-identity-resolver'
import type { TuiAgent } from './tui-agent'

/**
 * The agent a host publishes for a pane, for consumers that ACT on identity.
 *
 * Kept out of the runtime class so it can be tested without one, and so routing, delivery and the
 * UI all read the same decision instead of each re-deriving it.
 *
 * Title is included but ranks last, and contributes only when the evidence parser finds an
 * unambiguous name. A task title that merely mentions an agent yields no title evidence at all,
 * which is the whole point: "Switch Claude and Codex off the load balancer… - grok" is a Grok
 * pane, and used to receive both `@claude` and `@codex`.
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
