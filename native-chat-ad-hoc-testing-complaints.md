# Native Chat Ad-Hoc Testing Complaints

Collected from the ad-hoc release testing feedback on 2026-08-24.

These complaints, constraints, and release rules apply equally to the Codex and Claude native-chat restructures.

## Observed failures

- Repeated ad-hoc builds have been unusable in basic manual testing.
- A new Codex TUI session appeared not to spawn or render anything after the first interaction.
- A second attempt produced a failure switching the session to structured chat:
  `Couldn't resume chat — the agent terminal still owns this session`.
- The failure was visible within seconds of opening a worktree and trying the basic flow.
- Code review and focused unit tests did not catch the catastrophic end-to-end failure before an ad-hoc build was handed back for testing.
- A real Electron CDP run reproduced the same class of failure on this branch: native Codex chat answered a prompt, native → TUI adoption succeeded, and native → TUI launch then opened a Codex terminal whose `thread/resume` immediately failed with `already has an active writer` before returning to the shell.
- The failed launch was not an ordinary provider refusal: the durable flow had attempted to transfer ownership, but the new TUI could not prove a single-writer handoff. This is a release-blocking lifecycle failure because the user sees an apparently empty/non-spawning terminal and the conversation is left needing recovery.

## Process concerns

- Fixes appear to be accumulating as patches on top of earlier patches, increasing the chance of workaround-on-workaround behavior.
- We should remove hacky code rather than layer another guard over it.
- A senior review should be able to identify structural lifecycle problems before release, not only validate isolated functions.
- The current organization and test strategy are not providing enough confidence for a release candidate.
- Reviewers and implementation agents need to discuss findings and converge, rather than independently adding narrowly scoped fixes that can interact badly.

## Requested engineering bar

- Perform a structural review of the ownership, proof, handoff, restart, and recovery state machine.
- Prefer a small, explicit design with one authoritative owner/proof path over duplicated checks and special cases.
- Add failure-injection and end-to-end tests for the flows that fail in practice, including blank TUI sessions, prompt-created rollouts, retries, restart recovery, renderer rollback, process-stop proof, and native acquisition failure.
- Validate the real Electron surface before each ad-hoc release, not only stores, RPCs, or unit-test doubles.
- Use senior-level, precedent-driven design and call out or delete anything that is merely a workaround.
- Consider splitting the work into multiple reviewable PRs when the branch contains separate conceptual changes. Splitting should follow dependency boundaries and make correctness easier to review; it must not hide unresolved defects or be purely mechanical.
- The goal is that the next ad-hoc build works in the basic user flow without requiring the user to discover immediate catastrophic failures.
- Apply the same review and testing bar to Claude native chat; do not assume a Codex fix or review proves Claude safety.
- Do not prohibit ordinary users from actions they otherwise have access to. A refusal or capability gate is acceptable only for a developer-facing control, or after the user has gone through a clear path that explicitly opts them into an experimental feature and its limitations. Any user-facing refusal must preserve an ordinary supported fallback and must not silently strand the session.

## Ongoing instructions to retain across context compaction

- Keep working toward a genuinely usable ad-hoc release; do not stop at a green focused test run.
- Do not call a build ready when real Claude/Codex TUI cycles, the visible Electron flow, or relevant platform paths remain unverified.
- Use the available high-spec Windows machine and Linux/OpenClaw machine for platform testing when those paths are in scope.
- Run parallel senior reviews with the requested high-effort Claude and Codex reviewers, have them use the reference-driven review workflow, and require them to discuss findings with one another.
- Review the entire branch that produced the ad-hoc build, not only the latest bug fix.
- Check whether the branch should be split into multiple PRs. If it should, define a minimal correctness slice and defer unrelated feature slices instead of shipping a tangled branch.
- Consider landing the work incrementally behind a development-only toggle or explicit opt-in capability, preserving the current Codex path while the restructured path proves itself. The toggle must be deliberate, visible to developers, and removable; it must not silently fork behavior or become permanent configuration debt.
- Do not expand scope unnecessarily, but do include refactors and tests that are required to eliminate structural defects.
- Preserve the existing user-owned rollout documents; this note is the separate durable record of the complaints and release bar.

## Release decision rule

Do not cut or present the next ad-hoc build as ready until the structural audit, failure-injection tests, focused regression tests, visible Electron validation, and reviewer convergence are complete. Any remaining unverified platform or provider path must be stated plainly rather than implied to work.

## Progress tracker

Updated during the same release effort:

| Area                                    | Status                                          | Evidence or next action                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Blank Codex TUI safety                  | In progress / regression covered                | A blank TUI is kept alive and reports an actionable refusal; focused handoff test passes.                                                                                                                                                                                                                                                                                                        |
| Prompt-created Codex rollout retry      | In progress                                     | Owner re-proof now refreshes a missing rollout path before close; focused runtime and handoff tests cover it.                                                                                                                                                                                                                                                                                    |
| Renderer rollback after failed adoption | Covered                                         | Renderer test and visible Electron proof show terminal view is restored while the durable binding remains retryable.                                                                                                                                                                                                                                                                             |
| Focused regression suites               | Passing with parallelism caveat                 | Handoff/runtime suites and the broader five-file sweep pass; the 47-file matrix passes single-worker (301 tests), while an unconstrained parallel run exposed two timing/cleanup failures that must be made deterministic.                                                                                                                                                                       |
| Structural architecture review          | Complete / release blocking                     | Fable and Claude parity reviewers converged through the orchestration run: split by dependency seams; no second toggle; handoff/recovery and Claude proof gaps remain blockers. Reports: `~/orca-qa/native-chat-restructure-recovery-review-2026-08-24.md` and `~/orca-qa/claude-native-chat-parity-audit-2026-08-24.md`.                                                                        |
| Failure-injection test matrix           | Core local matrix covered                       | Dedicated handoff failure-injection coverage now covers prompt-created rollout discovery, cancellation refusal, dead `preparing` recovery, dead `new-owner-proving` recovery, and native acquisition/rollback paths; platform/process-table proof remains pending.                                                                                                                               |
| Visible Electron validation             | Blocked / rerun after fixes                     | The failure and safe refusal were reproduced in the real UI. The router shutdown omission is fixed, but the rebuilt source still exposed a second return-to-TUI readiness failure: a live PTY remounted after an undeliverable renderer input while Codex readiness timed out, leaving the UI in chat with a later-lived terminal process. A clean native → TUI → native cycle is still pending. |
| Windows/Linux/WSL/SSH                   | Pending                                         | Use the available Windows and Linux/OpenClaw hosts where the provider path is supported.                                                                                                                                                                                                                                                                                                         |
| Branch/PR split decision                | Decided: split for merge                        | Reviewers recommend PR-A shared/Codex core, PR-B handoff/recovery, PR-C Claude parity, and PR-D mobile, each against fresh main/dependency seams. The full branch may remain the ad-hoc test vehicle.                                                                                                                                                                                            |
| Incremental landing strategy            | Decided: use existing gate                      | Keep `experimentalNativeChat` plus provider capability negotiation; do not add a second dev-only toggle. The preview HTML was updated to reflect this proposal and remains an approval artifact.                                                                                                                                                                                                 |
| Claude native-chat parity               | Blocked by provider-proof fixes                 | The renderer/provider and tool-result dispatch fixes are present, but review found durable leaf tracking still accepts arbitrary frame UUIDs, deterministic session-id collision handling is incomplete, and the real signed-in Claude cycle remains unverified. Claude cannot be declared parity-safe from Codex evidence.                                                                      |
| Next ad-hoc release                     | Blocked pending correctness and packaging proof | Structural review is complete, but the Codex renderer/readiness race, Claude leaf/proof hardening, Windows process-table/start-time proof, provider cycles, and visible live-agent Electron validation remain.                                                                                                                                                                                   |

## Remote validation progress (2026-08-25)

- The pushed branch head `a357915cd1` is checked out through Orca CLI on the Windows high-spec host at `native-chat-validation-windows-high`. Repository setup completed. That host's running Orca app is still `1.4.186-hourly.202608200132` and does not advertise `agent-session.structured.*`, so it cannot yet prove native-chat behavior until the host app is updated.
- An Orca-managed SSH worktree was created on OpenClaw Linux at `/home/brennan/orca-native-chat-validation-openclaw-ssh` at the same branch head. The SSH worktree was created successfully; remote runtime terminal control still needs a live SSH/Orca runtime connection before Electron proof can be claimed.
- A supervised Grok Electron-validation dispatch is active. Its prompt explicitly requires invoking `$electron`/`/electron`, Playwright CDP only, and no computer-use or OS-level automation. It is responsible for visible local and remote checks and must report exact branch identity and blockers.

## Latest implementation progress (2026-08-25)

- Claude close/persist failure now preserves the live provider session until its durable handle is saved. A failed persistence attempt no longer deletes the in-memory session or closes the provider, so the native owner remains retryable and the handoff checkpoint stays recoverable. Adapter and flow-level regression tests cover this boundary.

- The fresh Electron failure was narrowed further: failed TUI launch cleanup waited on a terminal
  handle after `closeTerminal` could retire that handle, turning a stopped PTY into a false
  `StructuredTuiLaunchCleanupError` and leaving native ownership reported as unrecoverable.
- The launch path now uses the existing PID/start-time-safe structured exit proof after cleanup;
  it falls back to PTY exit proof only when provider process identity was never published. A focused
  regression covers the stale-handle cleanup race and passes with the router/handoff suites.
- This is a lifecycle correction, not a user-facing redesign. The rollout preview remains the
  approval artifact for any future copy, fallback action, toggle, or presentation change.
- The real Electron cycle must be rerun against this rebuilt source. The prior fresh profile run
  created native Codex successfully, but the test prompt invoked a long-running provider turn;
  the handoff was correctly refused while that turn remained running, so no new clean cycle is
  claimed yet.

## Latest visible Electron validation (2026-08-25)

- A source-backed Electron instance was verified as
  `brennanb2025/native-chat-restructure-recovery` on CDP port 9350.
- Creating a normal workspace terminal through the rendered UI and entering `codex` visibly
  launched Codex v0.149.1 to its interactive prompt in the target worktree; evidence is
  `/tmp/orca-native-chat-codex-launch.png`.
- This confirms ordinary terminal creation/provider startup on the current source. It does not
  prove native chat ownership transfer, a clean native → TUI → native cycle, Claude, or any
  Windows/Linux/WSL/SSH path.

## Latest direct-launch reproduction (2026-08-25)

- With `experimentalNativeChat: true` and `openAgentTabsInChatByDefault: true`, the rendered
  New tab → Codex action creates a durable structured Codex session and projects a new `Codex
Chat` tab, but the previously focused terminal remains active. The structured tab is present
  in `unifiedTabsByWorktree` while `activeTabId` still points at the terminal.
- This is the direct equivalent of the user's report that the first click “didn't spawn
  anything”: the work was created but the user was not taken to it. It is release-blocking
  because a successful provider launch is indistinguishable from a no-op in the visible UI.
- The intended correction is to activate the exact newly created structured tab after the
  session publication is observable, with a test that proves both durable creation and visible
  activation. This is a user-facing behavior change and is gated by the rollout-preview approval
  rule before source changes.

## Latest live Electron reproduction (2026-08-24)

- Dev app identity was verified as `brennanb2025/native-chat-restructure-recovery`.
- Through the real Electron surface, a worktree was opened, a Codex TUI was adopted into native chat, a native prompt returned the expected response, and native → TUI was requested.
- The launched TUI printed `thread/resume failed during TUI bootstrap: thread ... already has an active writer (code -32600)` and the PTY returned to `zsh` with no child process.
- Evidence captured during the run: `/tmp/orca-native-chat-validation-codex-spawn.png`, `/tmp/orca-native-chat-validation-codex-prompt.png`, `/tmp/orca-native-chat-validation-toggle.png`, `/tmp/orca-native-chat-validation-chat-response.png`, and `/tmp/orca-native-chat-validation-return-terminal.png`.
- The reproduction establishes that unit-level shutdown/lease tests are not enough: the release gate must observe the provider writer being gone before TUI `thread/resume` is sent, and must cover launch failure recovery through the visible Electron path.

## Structural audit findings (release blockers)

The high-effort review has confirmed that the repeated failures are structural, not just missing one guard:

- Claude restart recovery can wedge after the conversation leaf advances because recovery expects a stale leaf identity.
- A crash between closing the old owner and persisting the stopped stage can strand a session with no valid recovery path.
- The original Codex rollout guard checked a stale owner field before re-proving or re-resolving the live rollout, so “send a prompt and retry” could never heal in-session.
- Structured tab session identity is not safely persisted through the workspace schema, allowing restart to fall back to the wrong presentation/runtime.
- The cross-version agent-session wire suite is present but not included in the CI job that runs the related terminal wire tests.
- Windows process liveness probing and child teardown need to follow the host process-table and job ownership boundaries; the current paths risk per-PID shell churn and orphan/reaped children.
- Lease renewal can fail closed for every session when one poisoned record is encountered.
- Claude dispatch echo matching can bind a send to the wrong user-shaped frame during tool activity.
- Failed Codex cancellation can leave a turn permanently blocked.
- Fingerprint canonicalization rules can drift between client and host.

These findings are now the authoritative blocker list. They must be fixed, deleted, or explicitly excluded by a reviewed incremental rollout plan; adding more one-off guards is not an acceptable resolution.

## Latest progress (2026-08-24)

- Claude restart recovery no longer compares a live TUI against a frozen leaf UUID. Reproof reads the authoritative transcript leaf, returns a new resumed provider link, and the durable record persists it before recovery or handoff continues.
- Restart recovery now handles a dead TUI in `preparing` and `new-owner-proving` by committing a safe old-owner-stopped/abandoned stage and continuing the existing handoff operation instead of wedging on the recovery-only transition.
- The renderer records the structured provider on the tab, refuses to render a structured session with unknown provider identity, and uses a stable local target object. Claude no longer inherits a hardcoded Codex catalog.
- Claude dispatch replay waiters ignore top-level user frames made entirely of `tool_result` blocks.
- Mobile advertises the Claude structured capability and its session-tab model accepts both structured providers. Mobile typecheck and targeted transport/task tests pass.
- A full single-worker native-chat/Claude/runtime sweep passed 133 files, 1,096 tests (two skips), with the credential-dependent real Claude CLI handshake excluded. The credential-dependent test still needs a signed-in account to run.
- The restart recovery helper was split out to keep both modules under the repository max-lines ratchet.
- The PR cross-version wire job now runs the agent-session journey alongside the terminal journey instead of silently excluding it from CI.

## Failure-injection review progress (2026-08-24)

- Added a composed retry test for a Codex TUI that starts before its rollout is flushed, then creates the rollout after a user prompt; the next native handoff must discover the new durable path.
- Added restart tests for a dead TUI in both `preparing` and `new-owner-proving`; recovery now proves the old process stopped before retrying or restoring native ownership.
- Added a Claude restart test asserting that the newly re-proven transcript leaf is persisted before recovery is cleared.
- Added cancellation-failure coverage asserting that an unacknowledged native interrupt never launches a second TUI owner and leaves the native owner live/recoverable.
- Added a direct structured-launch failure test so the launch path produces an actionable error instead of appearing to do nothing.
- The focused handoff, restart, adoption, renderer-route, and RPC suites pass after these additions.

The structural audit still has an unresolved platform finding: `agent-session-process-identity-probe.ts` reads Windows start times by launching PowerShell per PID even though the runtime already has a centralized Windows process-table boundary. This remains a release blocker until it is moved behind that boundary or explicitly excluded from the first platform-qualified slice.

- Lease renewal is now isolated per session: one superseded/stale record cannot abort the durable renewal of every healthy session. Added sibling-failure regression coverage; focused lease suites (9 tests) and Node typecheck pass.
- Platform audit attempted the saved hosts. Windows high spec is reachable but runs an older build without `agent-session.structured.*` capabilities, so it cannot validate this branch until updated. The openclaw Linux environment was unreachable (`remote_runtime_unavailable`); no Linux/SSH proof is claimed.
- Windows process identity still uses per-PID PowerShell CIM for creation time because the native process-table module currently exposes no creation-time field. Replacing that path requires a separately reviewed native/API change; it remains a release blocker for full Windows handoff proof.

## Claude review additions (2026-08-24)

- Claude dispatch replay now requires the exact outgoing user payload before accepting a provider UUID; an unrelated root-user frame can no longer settle a send. A focused stale-replay regression passes.
- Duplicate AskUserQuestion labels are disambiguated (`label`, `label#2`, …), preventing one answer from overwriting another. The adapter regression passes and is included in commit `a7933dd3e0`.
- Claude close now has failure-injection coverage: if durable provider-handle persistence fails, the child is still closed, an `ended` event is emitted, and a repeated close is harmless (committed in `9ba7fa9e99`).
- Structured terminal tabs now persist `structuredSessionId` in the workspace schema (`50e08308b8`), preventing restart from silently routing a native owner back through PTY.
- Lease renewal is per-session rather than all-or-nothing (`2a77e2d95e`); a stale sibling cannot expire healthy sessions.
- A direct structured launch failure currently produces an actionable error toast and stays out of the terminal path. Offering an explicit “Open terminal agent” action is described in the HTML proposal but is not implemented pending user approval for that user-facing change.
- The real Claude CLI handshake remains credential-dependent. Ordinary suites now require explicit `ORCA_RUN_REAL_CLAUDE_TESTS=1` in addition to an installed CLI, so a signed-out local account is a deliberate skip rather than a false release regression. A signed-in run is still required for provider proof.
- Claude structured acquisition now retries its process start-time probe and refuses to publish an owner when the probe is unreadable (`f3444db789`); the spawn token is not treated as a self-asserted identity because Claude has no verified token echo hook.
- The live Codex active-writer reproduction is traced to `StructuredAgentSessionAdapterRouter` lacking `closeSession`; `suspendNative` therefore skipped native shutdown and launched TUI concurrently. The router now routes close to the owning provider adapter, retains ownership on an unproven exit, and the host handoff refuses when no close proof exists. Added a router regression test; node/web typechecks and the focused handoff suites pass.

## New Claude branch-identity audit (2026-08-25)

- A structural review sampled 200 real local Claude transcripts. The latest `last-prompt.leafUuid` matched neither a simple latest root-user UUID nor a stable frame namespace (observed marker records included assistant, user, system, and attachment rows).
- Therefore, treating a root-user frame as the durable Claude leaf is not sufficient, and dropping leaf checks in favor of session-id-only identity would permit silent sibling-branch adoption under concurrent resumes.
- The required proof is still unresolved: close/reproof must use the provider's authoritative transcript marker and prove continuity/ancestry from the persisted branch before accepting a new leaf. This is a Claude release blocker until covered by real-transport tests and a signed-in cycle.

## Codex/Claude close-proof failure matrix (2026-08-24)

- The provider adapter contract now requires `closeSession()` to return explicit `true` exit proof. The router, native handoff, and eviction paths fail closed for `false` or an unknown result, retaining ownership for a retry rather than launching a second writer.
- Codex and Claude `closeAll()` shutdown is bounded to three attempts and reports manual-recovery failure if a child remains indexed, preventing an unbounded shutdown loop when provider exit cannot be proven.
- Focused Codex/router/eviction/handoff suites pass (73 tests); Node and web typechecks pass after the runtime narrowing fix. The full Claude adapter suite still has one pre-existing failure while the in-progress leaf refactor drops the expected persisted `prompt-leaf` to `null`; this remains a Claude identity blocker, not a release-ready result.

## Exact-head Claude audit (2026-08-24, HEAD `4fc103cd0e`)

- The focused Claude adapter, integration, and legacy-adoption suites pass (28/28), but their
  fixtures model a synthetic root-user UUID as the durable leaf. They do not exercise the real
  transcript marker shape.
- A sample of 200 real Claude JSONL transcripts found that the final `last-prompt.leafUuid`
  pointed to `assistant` (58), `system` (76), `user` (39), or `attachment` (27) records; none
  matched the latest root-user UUID. The adapter's root-user tracking and the TUI proof's
  `last-prompt` tracking therefore identify different cursors.
- This is still a Claude release blocker. Dispatch replay may use a root-user UUID as the
  per-submission item identity, but owner/handoff continuity must persist the authoritative
  transcript cursor and validate `parentUuid` ancestry (descendant accepted; sibling, missing,
  malformed, or cyclic chain refused).
- The current real-CLI handshake test expects a non-null leaf immediately after a pre-minted
  `--session-id` startup, but no user frame exists at that point; it remains credential-gated and
  has not supplied release proof.
- Exact-head review also retains these blockers: direct structured launch can publish a hidden tab
  without focus intent (visible no-op), Claude launch args lack Codex's semantic allowlist, and
  Claude's deterministic pre-minted session id has no crash/collision healing path.
- A new P0 process-proof finding applies to both provider handoff and Claude specifically: the
  Claude stream connection marks itself exited on an `error` event before `exit`/`close` is
  observed. An error is not proof that the child stopped, so an error-only failure could launch a
  second writer. A failing-first regression must keep the session indexed and return `false` until
  exit/close or an independent PID-safe host probe proves death.
- Claude's journal translator still has a separate lifecycle predicate from dispatch replay: a
  top-level `user` frame with `parent_tool_use_id: null` starts a turn even when its content is
  entirely `tool_result`. This can churn turn state during tool activity; the predicate must be
  shared and covered with a real transcript-shaped regression.

## Codex failure-matrix review (2026-08-25)

- The Codex-side failure matrix is recorded at `~/orca-qa/codex-native-chat-failure-matrix-review-2026-08-25.md`.
- The shared handoff state machine can remain provider-neutral if ownership compares a stable provider root and history reconciliation carries an advisory provider cursor. Claude's session id is the root; transcript `last-prompt.leafUuid` is a cursor and must not be conflated with a root-user item UUID or a process-owner identity.
- Current focused Claude adapter/connection/launch/journal tests pass 36/36, and Node/web typechecks plus formatting pass. These are necessary checks, not release proof: the new error-without-exit case, real transcript ancestry, and visible Electron activation/handoff cases remain to be added or exercised.
- The Claude reviewer independently reported the same root/cursor conflation, so this is now a converged structural blocker rather than a provider-specific style preference.
