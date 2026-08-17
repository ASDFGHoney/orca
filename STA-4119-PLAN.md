# STA-4119 plan — leftover non-agent inventory must not hold a finished lead at `working`

## Decision

A Claude lead turn that has ended (`Stop` / `StopFailure` with `lead.state === 'done'`) must publish **`done`** even when a background shell / monitor is still in `background_tasks`. Live **child agents** on the roster still hold the pane at `working`. Session crons stay on the existing cron gate (out of scope).

This is a write-path change in `resolveClaudePaneState`, not a PTY-liveness backstop. Lane STA-4612 owns dead-pane / exit-path recovery. This lane owns the live pane whose lead is over and whose leftover process inventory currently upgrades `done` back to `working`.

## Why this, not a refresh loop

`claudeRunningNonAgentTaskPaneKeys` is written from `background_tasks` on lead events (`updateClaudeRunningNonAgentTask` in `src/shared/agent-hook-listener.ts`). An idle parent never emits another inventory, so the set is a one-way latch until the next lead turn.

Two ways to “re-evaluate the gate”:

1. **Keep the latch and poll / wait for a later inventory.** That reconciles after the fact, needs a signal the idle parent does not emit, and still publishes `working` while the shell is actually alive. It fails the acceptance oracle in `STA-4119-REPRO.md` (card/tab must reach `done` **while the background shell is still alive**).
2. **Stop letting leftover non-agent inventory participate in pane `state`.** Then a finished lead cannot be represented as `working` just because a child process lives. The latch can still be recorded for interrupt inference; it must not be an input to `resolveClaudePaneState`.

(2) makes the reported state unrepresentable. (1) does not.

`UserPromptSubmit` / `PreToolUse` / other mid-turn events still report `working` before `resolveClaudePaneState` sees a done lead. The pane stays `working` for a genuine lead turn, including one that happens to have a shell. That is the regression the coordinator forbade.

## Code change (single decision, few call sites)

In `resolveClaudePaneState` (`src/shared/agent-hook-listener.ts`), when `lead.state === 'done'`, return `working` only if:

- the roster has a working child, or
- the lead is not interrupted **and** `claudeActiveSessionCronPaneKeys` has the pane.

Remove `claudeRunningNonAgentTaskPaneKeys` from that predicate.

Same leftover-shell predicate is inlined in two other places and must be aligned so a shell cannot keep looking like a confirmed working gate after the lead is done:

- SubagentStop `hasConfirmedDoneGate` (~2682). That flag only decides whether a restored-child drain is “confirmed leftover inventory” vs “unconfirmed restore.” After this change a leftover shell is no longer a confirmed *working* gate, so this check must not treat the shell set as confirmation either. Otherwise a start-less `SubagentStop` (the reporter’s last event) can still mark the pane unconfirmed. After the resolve change, the re-emit is `done` if the cached lead is `done` and no child is working.
- The restored-snapshot guard on a lead Stop (~3110) currently requires `!claudeRunningNonAgentTaskPaneKeys.has(paneKey)` before marking `claudeUnconfirmedRestoredStatusPaneKeys`. A leftover shell would then skip that mark. Align this guard with the new resolve predicate (shells do not count as confirmation). Cron can stay.

Do **not**:

- add a PTY / pid liveness join (STA-4612)
- register `SessionEnd`
- map TUI-idle to `done` while the lead turn is still `working`
- invent a `backgroundOnly` render marker (closed #14620). Acceptance is `state === 'done'` on the card/tab.

Keep writing `claudeRunningNonAgentTaskPaneKeys` on lead inventories. `server.ts` still consults it so Escape/Ctrl+C at an idle prompt does not infer “interrupted done” over a provider-owned shell. That is interrupt inference, not sidebar `state`.

`turnCompletedAt` is only stamped when a lead Stop is gated **up** to `working`. After this change a shell-only Stop publishes `done` and does not need that stamp; the working→done edge is the completion notification. Stamping remains for a Stop that is still gated by a **working child** (existing #14580 behavior, unchanged).

## Tests (red before the resolve change, green after)

Add in `src/shared/claude-background-task-status.test.ts` (or the existing Claude subagent listener file) a STA-4119 case that is **red on current main**:

1. `UserPromptSubmit` → `working`
2. Lead `Stop` with `background_tasks: [{ type: 'shell', status: 'running' }]` and no child → **`done`** (today: `working`)
3. Start-less `SubagentStop` (native unmatched child stop) → still **`done`**, last published row is not `working` (today: `SubagentStop` / `working` — the reporter’s `last-status.json`)
4. `UserPromptSubmit` again → **`working`** (lead is active; leftover shell must not be “force everything to done”)
5. `Stop` while a roster child is `working` → still **`working`** + `turnCompletedAt` (do not ignore real child work)

Update existing tests that currently require `Stop` + `RUNNING_SHELL` → `working` so they expect `done` when no child is working. Keep tests that require `Stop` + running **subagent** → `working`.

Notification tests in `agent-hook-completion-background-turn-notifications.test.ts`: the shell-only sequence should announce on the `done` Stop, not on a gated-working Stop. The subagent-gated sequence stays on `turnCompletedAt`.

No new hook opcode, no new persisted field. Publishing `done` instead of `working` for this inventory is the intended product change; mixed-version remotes already understand both states.

## Hibernation / keep-awake (accepted tradeoff)

`agent-hibernation-planner.ts` refuses any pane with `state !== 'done'`. After this change a finished lead with a live leftover shell is hibernation-eligible. That matches “the lead is idle.” Killing a long-lived `npm run dev` by sleeping the worktree is the same class of leftover-process risk the reporter already works around by putting servers in a dedicated tab. Not in scope to invent a third pane state.

## Precedent (local reference checkouts; names omitted from this file on purpose)

A peer agent-session tracker in the local reference tree uses this exact state machine for hook-driven session status:

- `userPromptSubmit` / `preToolUse` / `postToolUse` → working
- `stop` → **idle**
- `subagentStop` → **unchanged** (a child finishing does not make the parent working)
- process-exit is a backstop only for a session that has **ended**, not for leftover children of a live idle parent

That is the same split this plan uses: lead Stop is idle; leftover child processes are session inventory; dead-pane recovery is a different ticket.

I did not find a peer that treats “provider-owned background shell still running” as “the lead turn is still working.” If we kept that latch we would be the unusual one, and we would fail the acceptance oracle.

## Acceptance (from `STA-4119-REPRO.md`)

After implement, re-run the exact macOS repro:

- TUI idle, `1 shell still running`, PTY alive
- card/tab **`done`** (not `working`)
- last-status not stuck on `SubagentStop` / `working`
- control (no shell) still `Stop` / `done`
- a turn that is actually running tools still shows `working`

Do not implement until a Claude Fable review and a fresh Codex verify of this plan both return clean.
