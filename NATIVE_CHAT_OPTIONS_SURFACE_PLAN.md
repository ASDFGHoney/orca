# Native chat options surface: gap analysis and implementation plan

## Outcome

Orca already has a real desktop model picker for both native-chat transports. The gap is not basic wiring: the PTY/bridge path builds a catalog-backed snapshot and applies catalog commands, while the structured Codex path replaces that snapshot with provider-discovered models and sends selections through `agentSession.setOption`. The immediate high-value change is to make the current model and reasoning effort one always-visible desktop affordance, matching mobile's existing information architecture while retaining Orca's primitives and visual language.

The broader extensibility boundary is incomplete. `SessionOptionDescriptor` and `SessionOptionsSurface` are generic enough to render additional select/boolean controls without provider-specific component edits, but the structured result shape and projection are explicitly model/effort-shaped. Approval policy, sandbox mode, plan mode, and MCP toggles are therefore not catalog-only additions today.

## Evidence: what renders today

### PTY/bridge chat

1. `NativeChatView` renders `NativeChatComposer` for the transcript-backed chat surface.
2. `NativeChatComposer` calls `useNativeChatSessionOptions`, which resolves provider models, constructs `createNativeChatPtySessionOptions`, and subscribes to its snapshot.
3. `NativeChatComposerField` passes the surface and descriptors into `NativeChatComposerActions`.
4. `NativeChatComposerActions` renders `NativeChatSessionOptionPickers` inside the composer action row, between attachments and dictation/send.
5. The PTY surface uses catalog `midSession` strategies through `native-chat-session-option-apply.ts`: direct slash commands, toggle commands, or a switch to the agent's picker.

### Structured Codex chat

1. `NativeChatStructuredSession` calls `useStructuredAgentSession`, then passes `controller.optionSurface` and `controller.optionSnapshot` through `structuredTransport` to the same `NativeChatComposer`.
2. `useStructuredAgentSession` reads `agentSession.options`, projects it through `structuredAgentSessionOptionCatalog` / `structuredAgentSessionOptionSnapshot`, and supplies a `SessionOptionsSurface` whose `setOption` calls `agentSession.setOption` with the current fence and idempotency envelope.
3. `NativeChatComposer` explicitly prefers `structuredTransport.optionsSurface` and `structuredTransport.optionSnapshot` over the PTY surface.
4. The same `NativeChatSessionOptionPickers` therefore renders in structured chat today. Bare `/model` and `/effort` composer commands open its native menus instead of being sent as chat text.
5. The host RPC delegates to `StructuredAgentSessionHost.setOption`, whose mutation plan calls the adapter. `CodexStructuredSessionAdapter.setOption` accepts only recognized Codex turn keys; model and effort are validated against live `model/list` results before becoming next-turn overrides.

Conclusion: structured model/effort controls are not bridge-only. They are rendered in the same composer component and take a distinct protocol apply path.

## Transport truth table

| Provider/catalog option         | Draft launch                      | Live PTY/bridge                                             | Structured transport today                                                                                         |
| ------------------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Codex model                     | `-m`                              | Opens the TUI `/model` picker by typed delivery             | Works natively through `agentSession.setOption`; choices come from app-server `model/list`                         |
| Codex effort                    | `-c model_reasoning_effort=…`     | Opens the same TUI `/model` picker by typed delivery        | Works natively through `agentSession.setOption`; choices are restricted to the selected model's advertised efforts |
| Claude model                    | `--model`                         | Sends `/model <id>`; may hand off for a confirmation prompt | No production structured Claude adapter/options reader, so it is not surfaced                                      |
| Claude effort                   | `--effort`                        | Sends `/effort <value>`                                     | Not surfaced on structured transport                                                                               |
| Claude fast mode                | No launch apply                   | Sends the flip-only `/fast` command                         | Not surfaced on structured transport                                                                               |
| Gemini model                    | `-m`                              | Opens the TUI `/model` picker                               | Not surfaced on structured transport                                                                               |
| Cursor model                    | `--model`                         | Sends `/model <id>`                                         | Not surfaced on structured transport                                                                               |
| Cursor effort / fast / thinking | Composed into the launch model id | Applied by changing the composed model through `/model`     | Not surfaced on structured transport                                                                               |
| Grok model                      | `-m`                              | Sends `/model <id>`                                         | Not surfaced on structured transport                                                                               |
| Grok effort                     | `--reasoning-effort`              | Sends `/effort <value>`                                     | Not surfaced on structured transport                                                                               |

The slash-command-only entries do not currently “silently do nothing” in a structured session because the structured projection does not publish them. That is the honest degradation. The dangerous future behavior is `settableState(... liveTransport: 'agent-session')`, which currently marks every projected descriptor settable without a per-option transport capability. A future generic projection of seed options would make unsupported controls look enabled unless applicability becomes explicit.

## Abstraction assessment

### What is already reusable

- `CatalogOption` describes select/boolean values, labels, categories, launch application, and PTY mid-session application without component-specific branches.
- `SessionOptionDescriptor` is provider-neutral and drives desktop and mobile controls.
- `SessionOptionsSurface` is a small transport-neutral apply/subscribe contract.
- Model-scoped options, provider-scoped model discovery, unknown values, disabled reasons, and reported/applied/dispatched truth are already represented.
- Mobile already combines model and effort in one pill using the same descriptor snapshot, proving this information architecture does not require a wire change.

### What blocks catalog-only capability additions

- `AgentSessionOptionsResult` contains only `models`, per-model `efforts`, and `current.model/current.effort`.
- `structuredAgentSessionOptionCatalog` synthesizes only an `effort` option and replaces the seed model options, rather than projecting provider-reported generic option descriptors.
- `commitStructuredAgentSessionOptionValues` is hard-coded to `model` and `effort`.
- Structured writes accept strings only; booleans and richer modes cannot cross this path.
- The Codex adapter allowlist includes `approvalPolicy`, `approvalsReviewer`, `personality`, and `serviceTier`, but the read result and UI catalog do not expose them. Approval policy would still require adapter read semantics, wire projection, and state reconciliation.
- Sandbox mode is not a Codex per-turn option in the current allowlist. Supporting it needs a provider lifecycle decision (session/thread scope versus next-turn scope), not just a catalog row.
- Plan mode needs an explicit provider meaning and apply capability. MCP toggles need capability discovery and probably session/provider lifecycle handling; neither should be modeled as an assumed slash command in structured chat.

Therefore approval policy and sandbox mode cannot be added today by editing only `agent-session-option-catalog-claude-codex.ts`. The renderer surface likely would not need provider-specific edits once generic descriptors exist, but shared wire types, provider adapters, and structured projection/state would.

## Ranked product gaps

| Rank | Gap                                        | User value                                                                                                    | Cost                                                                                                                           | Decision                                     |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 1    | One inline current model + effort control  | High: users can verify and change the two most consequential turn settings at the point of action             | Low: desktop-only composition over existing descriptors/surface                                                                | Implement now                                |
| 2    | Explicit scope binding above the composer  | High: prevents acting in the wrong worktree/folder/SSH host                                                   | Medium: needs a truthful read-only binding first, then a carefully scoped chooser that respects workspace and remote ownership | Plan next; do not smuggle it into the picker |
| 3    | Named presets/modes                        | Medium-high: provides a durable extension point for model, effort, approval, sandbox, and future capabilities | High: requires schema, ownership, validation, mixed-version behavior, and launch/live semantics                                | Design after generic capabilities            |
| 4    | Intent-driven empty state                  | Medium: accelerates first prompt and makes the chat surface feel purposeful                                   | Low-medium: prompt seeding, responsive cards, accessibility, localization                                                      | Follow after scope binding                   |
| 5    | Top-level extensibility/plugins navigation | Medium for advanced users, lower for the immediate chat task                                                  | High and app-wide                                                                                                              | Out of scope for native-chat options         |

## Implementation order

### Phase 1 — focused desktop picker (this branch)

1. Combine the current model and reasoning-effort values into one always-visible trigger, with the existing model and effort descriptors presented as sections of one dropdown.
2. Keep non-effort options in the adjacent generic options control. This preserves fast mode and future modes without forcing them into the model label.
3. Reuse `Button`, `DropdownMenu`, `Tooltip`, existing tokens, and a Lucide glyph. Do not copy the reference's colors, dimensions, or shadows.
4. Preserve transport honesty from the descriptor: PTY agent-picker actions remain actions; structured model/effort remain radio choices; disabled descriptors remain disabled; the whole control locks during a turn or pending apply.
5. Add component tests for the combined label/menu and a renderer integration test that starts from provider-discovered structured options, activates a picker row, and observes the real `agentSession.setOption` request and reconciled snapshot.

Benefit: the most important state becomes legible at a glance, desktop reaches parity with mobile, and both transports retain their existing proven apply behavior. No RPC or journal change.

### Phase 2 — generic structured capabilities

1. Introduce a JSON-safe, provider-reported option descriptor/result that carries stable id, kind, choices/current value, category, scope, and apply capability. Keep all new fields optional and retain the current `models/current` fallback for older hosts.
2. Make the adapter report supported options and accepted value types; do not infer support from the static catalog or make all agent-session descriptors settable.
3. Generalize structured state reconciliation and commits beyond the hard-coded `model`/`effort` loop.
4. Add approval policy first because Codex already supports it as a turn option. Define its current-value source and old-host fallback before surfacing it.
5. Treat sandbox mode separately until the provider contract proves whether it can change safely on an existing thread/session. Disable or launch-scope it when it cannot.
6. Add plan mode and MCP controls only when their providers expose capability and current-state truth.

Benefit: future supported capabilities can reach desktop and mobile from descriptors without rewriting either picker. Cost: shared wire + host + adapters + both clients, with mixed-version tests.

### Phase 3 — presets

1. Define a preset as a named, provider-scoped set of option targets plus optional prompt/tool context.
2. Resolve every target against the current transport capabilities and show partial/incompatible presets explicitly; never silently drop a security-related target.
3. Apply atomically where the provider supports it, or show ordered partial results where it does not.

Benefit: an Orca-native equivalent of the reference's `Custom` affordance that can grow with capabilities instead of becoming a row of toggles.

### Phase 4 — scope and empty state

1. Add a read-only scope row above the composer first: worktree or folder workspace, execution host, and session binding.
2. Add a chooser only after the create/attach semantics can preserve folder workspaces, SSH execution ownership, and active-session safety.
3. Add Explore / Build / Review / Fix intent cards as draft starters, not auto-sends. Keep them responsive and hide them after the first journal item.

Benefit: clearer “where” and “what” before the first turn without mutating the shared journal format.

## Wire compatibility and mobile

- Phase 1 is renderer-only. It changes neither RPC params/results nor journal content. Remote structured sessions continue to rely on the already-negotiated `agentSession.options` / `agentSession.setOption` methods; old hosts continue to fail the option read and produce no enabled control.
- Phase 2 is a wire change even if implemented as optional JSON fields. Per `docs/reference/remote-wire-compatibility.md`, new fields must remain optional with a current-shape fallback. If a new method or behavior is required, advertise it in runtime capabilities before calling it. Add both skew directions to `cross-version-agent-session-wire.unit.test.ts`.
- Do not add a stream opcode for options; existing runtime RPC is the right framing.
- The journal currently renders conversation content on both desktop and mobile, while option state is read separately through `agentSession.options`. Phase 1 therefore does not alter mobile journal rendering.
- Phase 2 affects mobile because mobile already consumes the same option result and descriptor projection. Shared type/projection changes must preserve its combined picker, and new capabilities need mobile rendering/disabled-state tests even when desktop initiates the feature.
- Scope and intent-card changes should remain client UI/draft state. Putting preset application or scope changes into journal rows would change what old clients render and must be avoided or capability-gated.

## What this work will not do

- It will not copy Codex desktop's visual styling; only the combined, inline information architecture is adopted.
- It will not expose approval, sandbox, plan, or MCP controls before providers can report and apply them truthfully.
- It will not type structured-only options into a nonexistent TUI or reinterpret contact loss as an apply failure.
- It will not persist structured live choices as global launch defaults; next-turn session state and future-session defaults are different user intents.
- It will not add project switching to an active conversation without defined worktree/folder/SSH ownership semantics.
- It will not make plugins/navigation part of this focused picker branch.
