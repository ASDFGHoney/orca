# STA-4119 reproduction

**Verdict: reproduced on both macOS and Windows.** The reported mechanism is real and is not a Windows-only artifact. It is also not the phantom-working bug fixed by #14375 / #15082.

The pane stays `working` after the lead turn ends because a live background shell (and a start-less `SubagentStop`) keeps the background-task / child gate up. The owning Claude PTY is still alive, sitting at an idle `❯` prompt. A hooks-independent PTY-liveness join (STA-4612 as specified) does **not** clear this case.

## Builds

| Surface | App | Contains #14375 / #15082 / #14580? | Claude Code |
| --- | --- | --- | --- |
| Local macOS Orca (authoritative "has the merged status PRs" build) | `1.4.185-adhoc.20260817215434` | Yes. Source worktree HEAD `8cd338357ee35e7348cb08d3a0522fee161b2e28` is a descendant of `d137bb93e1` (#14375), `60805f5c45` (#15082), and `5e9e38fa75` (#14580). The running adhoc binary stamps `turnCompletedAt` on the gated working row, which is the #14580 signal. | v2.1.233 |
| Windows high spec remote (`runtimeId` `70a74ef9-bd02-4f76-b08b-846e230d2dc5`) | `1.4.184` (runtime ready; desktop app not running) | No. 1.4.184 predates those merges. Confirmed in-product: the working row has **no** `turnCompletedAt`. | v2.1.234 |
| Windows low spec | Unreachable (`ok: false`) | n/a | n/a |

This lane did not cherry-pick anything. The macOS run is the "still broken after the two merged status PRs" result. The Windows run is the original-platform result on the shipped 1.4.184 the reporter's era used.

## Exact steps (what I actually ran)

Throwaway fixture, not the orca repo (no setup hooks, no sibling-worktree discovery):

1. Create `/tmp/sta-4119-bg-fixture` with `package.json` `dev` → `python3 serve.py` (sleeps 3600s). `orca repo add --path /tmp/sta-4119-bg-fixture`.
2. **macOS:** `orca worktree create --repo id:a2200db1-ead2-44b2-98ef-305f17644241 --name sta-4119-repro-macos --no-parent --agent claude --setup skip`
   - handle `term_0a08d384-10a2-49ec-a5da-a6defc516cac`
   - paneKey `b1a746f4-93d0-483a-9b56-841d3d38b3c5:45175c2f-d16d-4ff4-bc95-809fed804872`
3. **Windows:** `orca worktree create --environment "Windows high spec" --repo id:be84c937-38c9-426c-aa55-300e8f658a83 --name sta-4119-repro-win --no-parent --agent claude --setup skip`
   - handle `term_ab5aff7b-d73e-4946-b445-dfdfc729b68f`
   - paneKey `0eefb1da-3af1-40cb-ab8c-309eea05e5cb:d96df5f8-1870-42e2-b11b-a50bbc6c6985`
   - path `C:/Users/neil/orca/workspaces/orca-setup-shell-repro/sta-4119-repro-win`
4. Accept Claude's workspace-trust prompt (`1. Yes, I trust this folder`).
5. Send the same lead prompt on both panes:

   > Do exactly these steps, then end your turn. Do not start a subagent. Do not ask questions.
   > 1. Start this long-lived process as a background/async Bash shell and do NOT wait for it to exit: `python3 -c "import time; print(\"sta-4119-bg-started\", flush=True); time.sleep(3600)"` (fallback `python` / `sleep 3600`).
   > 2. Confirm the process is running in the background.
   > 3. Reply with exactly `STA-4119-TURN-DONE`.

6. Wait until `orca terminal wait --for tui-idle` is satisfied and the TUI shows the final assistant line plus an idle `❯`.
7. Read `last-status.json` for that pane and `orca worktree ps` card/agent state. Re-check ~5 minutes later.

**Control (same macOS adhoc build, no background work):** worktree `sta-4119-control-macos`, prompt "Reply with exactly STA-4119-CONTROL-DONE and end your turn. Do not run any shell command."

## What I observed

### Both platforms (the reported bug)

After the lead printed `STA-4119-TURN-DONE`:

- Claude TUI sat at an idle `❯`. Footer: `1 shell` / `1 shell still running`. Status line also showed `← for agents` even though the prompt forbade a subagent.
- `orca terminal wait --for tui-idle` returned satisfied. The PTY was still running.
- Worktree card / agent row stayed `working`. Windows tab title kept the working glyph (`✳ STA-4119 background shell test`).
- Last hook Orca stored for the pane was **`SubagentStop` with `payload.state: "working"`**. No later hook arrived while the background shell lived.
- The `SubagentStop` carried a `toolAgentId` that never had a matching visible `SubagentStart` in the pane status. That matches the already-measured fact that start-less `SubagentStop` is native traffic.

Re-check at 16:37:44 local, ~5 minutes after the macOS `SubagentStop` (16:32:58) and the Windows one (`receivedAt` 1787009583714): **same last event, still `working`.** This is not a brief race.

Windows extra: Claude printed `Background command "Start long-lived background process" failed with exit code 49` and still showed `1 shell still running`. The inventory Orca consumed was still a live shell as far as Claude's own status line was concerned.

### macOS 1.4.185-adhoc (has #14375 / #15082 / #14580)

`~/Library/Application Support/orca/agent-hooks/last-status.json` pane entry (full dump: `sta-4119-macos-last-status-entry.json`):

```json
{
  "hookEventName": "SubagentStop",
  "toolAgentId": "ac4a0c329a0e18cd9",
  "payload": {
    "state": "working",
    "lastAssistantMessage": "STA-4119-TURN-DONE",
    "toolName": "Bash",
    "turnCompletedAt": 1787009576866
  },
  "receivedAt": 1787009578408,
  "stateStartedAt": 1787009567895
}
```

`orca worktree ps`: card `status=working`, agent `state=working`, last message `STA-4119-TURN-DONE`. Unchanged 5 minutes later.

`turnCompletedAt` is present. That is the #14580 stamp: lead `Stop` was gated back up to `working` by the background shell, and the listener recorded the turn-end time so the completion coordinator *can* announce without waiting for `done`.

### Windows 1.4.184 (original platform, pre-#14580)

`C:\Users\neil\AppData\Roaming\orca\agent-hooks\last-status.json` for pane `0eefb1da-…:d96df5f8-…` (fields: `sta-4119-windows-last-status-fields.json`; full entry on the host at `sta-4119-win-last-status.json` in that worktree):

- `hookEventName=SubagentStop`
- `state=working`
- `turnCompletedAt=None` — **not in `payloadKeys`**
- `lastAssistantMessage=STA-4119-TURN-DONE`
- `toolName=Read`
- `toolAgentId=a0dc6d9fd3ea4d8be`
- `receivedAt=1787009583714`

This is the reporter's evidence, reproduced on the reported OS, on 1.4.184.

### Control (macOS adhoc, no background shell)

```json
{
  "hookEventName": "Stop",
  "payload": {
    "state": "done",
    "lastAssistantMessage": "STA-4119-CONTROL-DONE"
  }
}
```

Card `status=active`, agent `state=done`. Same build, same Claude major, no background inventory → the working→done edge happens.

## Did the completion notification fire?

| Build | Notification |
| --- | --- |
| Windows 1.4.184 | **No path for it to fire.** Last row is `working` with no `turnCompletedAt` and no later `done`. The old coordinator only announces on a working→done (or equivalent) edge. Matches the reporter ("no completion notification, no sound, no chip"). |
| macOS 1.4.185-adhoc | **Stamp present, banner not independently observed.** The gated working row carries `turnCompletedAt=1787009576866`, which is exactly the signal #14580 added so the coordinator can announce the finished turn while the pane stays `working`. I searched `~/Library/Application Support/orca/logs/main.trace.ndjson` and `daemon.log` for `agent-task-complete` / this paneKey / `STA-4119-TURN-DONE` and found no dispatch log. I did not see an OS banner from this session. I am **not** claiming the live banner fired; I am claiming the data the coordinator needs is on the row. |

#14580 (`fix(agent-status): announce Claude turn complete while background work runs`) is already on this source HEAD. #14620 (stop *rendering* the leftover gate as foreground work) was **closed unmerged**. So on current main the remaining user-visible half of STA-4119 is the spinner/card staying "Claude is working right now" while the TUI is idle.

## Mechanism (checked against this tree, not the handoff line numbers)

`resolveClaudePaneState` (`src/shared/agent-hook-listener.ts`) returns `working` when the lead is `done` if a roster child is working **or** `claudeRunningNonAgentTaskPaneKeys` / session-cron gates are set.

`updateClaudeRunningNonAgentTask` runs on lead events that carry `background_tasks`. A running `type: "shell"` is a non-agent task (`src/shared/claude-background-task-inventory.ts`). Folding the inventory into the roster happens on a **lead turn boundary** (`Stop` / `StopFailure`). An idle parent never emits another inventory.

A later start-less `SubagentStop` (native traffic; we saw one on both platforms after a prompt that forbade subagents) re-emits the cached lead as `working`. That is why `last-status.json` ends on `SubagentStop` / `working` — same as the reporter — rather than on the lead `Stop`.

This is **not** the #14375 phantom: the gate has positive evidence (Claude's own "1 shell still running", a `turnCompletedAt` stamp on the adhoc build, a live PTY). Working is what the current state machine intends given that inventory.

## STA-4612 subsumption verdict: **does not subsume this case**

STA-4612 proposes a hooks-independent backstop that is either:

1. process-exit of the owning agent, keyed by pid + start time, or
2. a read-time liveness join with "the owning session/PTY is still live"

so a *dead* pane cannot stay `working`.

**Here the pane is alive.** Claude is at an idle prompt. `orca terminal wait --for tui-idle` succeeds. The background shell is a **child of that still-live PTY**, not a replacement for it. Intersecting status with "PTY live" still yields live + `working`. Process-exit never fires because the Claude process has not exited.

STA-4612's write-up also lists "background-task gate never refreshed" for the *other* failure: a background task **ends** while the parent stays idle, so the inventory is stale and nothing clears the gate. That is a sibling, not this ticket. This ticket's reporter case is "the shell is still running, the turn is over, stop looking like foreground work / fire the finish notification." PTY liveness does not distinguish those.

A TUI-idle → `done` fallback (the reporter's first suggestion) would also fight keep-awake / hibernation, which currently treat `state !== 'done'` as live work. #14620's closed approach — keep `state=working` for those systems, but stop *drawing* it as foreground activity — is the product-shaped remaining fix if notification-on-`turnCompletedAt` is accepted as sufficient for the banner half.

## Post-fix (this worktree)

Plan: `STA-4119-PLAN.md`. Reviewed CLEAN by Claude Fable (`task_599c4da8f712`) then independently verified CLEAN by a fresh Codex worker (`task_fa35d597c48c`) before any production edit.

The reporter sequence is now a unit test (`does not hold a finished lead at working for a leftover background shell`). It was **red** on the pre-change listener (`Stop` + running shell published `working`) and is **green** after removing leftover shells from `resolveClaudePaneState` / the two sibling predicates.

147 related tests pass (`claude-background-task-status`, Claude subagent listener, background-turn notifications, last-status write/lead-boundary, hook ingest, interrupt inference, relay hook server).

Live UI re-run against this commit is **not** possible in the currently running desktop (`1.4.185-adhoc.20260817215434`): that binary does not load this worktree. The leftover `sta-4119-repro-macos` / `sta-4119-repro-win` panes will stay `working` until a build that contains this change processes a new hook (or the session is restarted on that build).

## What is left

- Merge the PR that implements `STA-4119-PLAN.md`.
- Re-run the live macOS repro on a desktop that includes this commit: card/tab must be `done` while `1 shell still running`.
- Repro worktrees left running on purpose: `sta-4119-repro-macos` (local) and `sta-4119-repro-win` (Windows high spec). Kill the background `sleep`/python if they should not keep a core parked.

## Evidence files

- `sta-4119-macos-last-status-entry.json` — full local last-status rows for repro + control
- `sta-4119-windows-last-status-fields.json` — extracted Windows last-status fields
