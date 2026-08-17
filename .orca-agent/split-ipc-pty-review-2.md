# Split review (round 2): `src/main/ipc/pty.ts`

Adversarial follow-up to [split-ipc-pty-review-1.md](./split-ipc-pty-review-1.md). Dest files live under `src/main/ipc/pty/`. Barrel is `src/main/ipc/pty.ts`. Line counts are physical last-line from file reads (no `wc` in this pass).

## Verdict

**Still not done.** Round 1's dead `pty-spawn-cwd.ts` is now wired. Barrel, dest→barrel imports, naming, max-lines disables, and `Record<string, any>` checks pass. The 400-line hard cap still fails on the same three dest files; `pty-runtime-controller.ts` grew (608 → 1583) instead of being split on the plan B seams. No new unused dest module. Remaining risks are re-registration live-binding windows, duplicated spawn paths (SSH/WSL/folder drift), and fragile IPC uninstall.

---

## 1. 400-line cap

**Fail.** Barrel is 39 lines. Three dest files still exceed 400 physical lines.

| File | lines | Cap |
|------|------:|-----|
| `src/main/ipc/pty.ts` | 39 | ok |
| `src/main/ipc/pty/register-pty-handlers.ts` | **2579** | **FAIL** |
| `src/main/ipc/pty/pty-runtime-controller.ts` | **1583** | **FAIL** |
| `src/main/ipc/pty/pty-ipc-spawn.ts` | **1415** | **FAIL** |
| `src/main/ipc/pty/pty-ipc-inspect.ts` | 320 | ok (counted max-lines 300 may still trip) |
| `src/main/ipc/pty/pty-codex-home-env.ts` | 301 | ok (same) |
| `src/main/ipc/pty/pty-stable-pane-owner.ts` | 293 | ok |
| `src/main/ipc/pty/pty-host-env.ts` | 270 | ok |
| remaining dest files | 12–210 | ok |

Plan B is still incomplete:

- No `PtyIpcSession`. Delivery accounting, pending flush, accept path, serialize table, resize/visibility/ack IPC, Codex-resume helpers, and `adoptStablePane` remain inside `register-pty-handlers.ts`.
- `pty-ipc-spawn.ts` was not split into `pty-ipc-spawn-preflight` / `pty-ipc-spawn-commit`.
- `pty-runtime-controller.ts` absorbed more spawn/kill/list/resize instead of `pty-runtime-controller-spawn-*` / `-kill`.

`config/max-lines-baseline.txt` still has `inline src/main/ipc/pty.ts`. After the barrel shrink that ratchet line is stale (plan: `pnpm run check:max-lines-ratchet --prune`).

Oxlint counted max-lines is 300. Do not add a disable if inspect/codex-home trip it — split.

---

## 2. Unused extracted modules

**Pass (modules).** Every dest file has a consumer. Round 1's unused `pty-spawn-cwd.ts` is imported from `register-pty-handlers.ts` and passed into spawn + controller.

Thin store-binding wrappers (not a second copy of the logic):

```2013:2020:src/main/ipc/pty/register-pty-handlers.ts
  const assertFolderWorkspacePtyPathUsable = (worktreeId: string | undefined): Promise<void> =>
    assertFolderWorkspacePtyPathUsableImpl(store, worktreeId)

  const resolvePtySpawnStartupCwd = (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ): string | undefined => resolvePtySpawnStartupCwdImpl(store, worktreeId, cwd, missingDirFallback)
```

**Unused exports** (not unused files; leftover public surface):

- `pendingSerializerGenSeq`, `cleanupPendingPaneSerializersForSender` in `pty-pane-serializer-state.ts`
- `clearPaneSpawnReservation`, `releaseRuntimePaneCreate` in `pty-pane-spawn-reservation.ts`

Keep them unexported or use them only internally so they do not look like a second API.

---

## 3. Circular imports / barrel

**Pass (hard cycles).**

- Dest files do not import `../pty` / `../../ipc/pty`.
- No `src/main/ipc/pty/index.ts`.
- Consumers still import `./pty` / `../ipc/pty` (`daemon-init.ts`, `ssh-relay-session.ts`, `attach-main-window-services.ts`, `pty.test.ts`).

Graph is one-way: barrel → dest; `register-pty-handlers` → installers; `register-headless-pty-runtime` → `register-pty-handlers`. Sibling state modules (`ownership` ← `registry` ← `agent-session-owners` ← `cleanup` ← `liveness`) do not loop.

**Soft coupling (not an import cycle):** module-scope `export let` bridges in `pty-renderer-visibility-state.ts`, `pty-provider-listener-lifecycle.ts`, and `pty-renderer-delivery-debug.ts` are mutated by `register-pty-handlers` and invoked from cleanup / lifecycle-reset / daemon-init. That is the intended live-binding pattern.

---

## 4. Setter / live-binding mistakes

Setters exist and assignments from other modules go through them (`setInvalidatePendingPtyDrain*`, `setRebindProviderListeners`, `setLocal*Unsub`, `setRead/Reset*Snapshot`, `setLocalPtyProvider`). `unbindLocalProviderListeners` assigns `localDataUnsub = null` in the **defining** module — legal ESM, live for importers.

Call sites use the imported binding at **call** time (not a captured snapshot), e.g. `clearProviderPtyState` → `invalidatePendingPtyDrainPriority(id, false)`, `rebindLocalProviderListeners` → `rebindProviderListeners?.()`. That is the correct live-binding use.

### Remaining live-binding risks

| Sev | Issue |
|-----|--------|
| Medium | Re-registration **neutralizes drain/accounting immediately** (`setInvalidate*(() => {})`, `setResetRendererDeliveryAccountingForLifecycleReset(() => {})`) but does **not** neutralize `rebindProviderListeners`. `setRebindProviderListeners(bindProviderListeners)` is at line 1868. A daemon `replaceDaemonProvider` in that window (`daemon-init.ts` calls `rebindLocalProviderListeners`) rebinds `onData`/`onExit` to the **old** `acceptPtyDataForRenderer` / `sendPtyExitToRenderer` closure. Neutralize rebind at the same moment as drain, or retarget it before any await. |
| Medium | Symmetric window the other way: drain is a no-op from register start until line 1203. `LocalPtyProvider.configure({ onExit })` and SSH teardown can call `clearProviderPtyState` in that window; priority/policy invalidation is dropped. Pre-existing shape, but the window is now ~1200 lines of setup. |
| Low | `setResetRendererDeliveryAccountingForLifecycleReset` at line 690 closes over `sshOutputIntake` before it is constructed (line 1683). Optional chaining makes this a no-op if a lifecycle reset fires in between; SSH projection transfer would be skipped for that reset. |
| Info | `export let localProvider` / drain fns rely on ESM live bindings. electron-vite bundling usually preserves them; a CJS snapshot would freeze `killAllPty` / drain on the initial values. Setters + same-module assignment are the safe half; imported **reads** are the fragile half. |

`bindProviderListeners` correctly unsubscribes via imported live unsubs then `setLocal*Unsub(...)`. That path is sound.

---

## 5. Behavior deltas

No intentional public API change. Barrel matches the plan.

**Highest ongoing delta risk: two full spawn implementations.**

`pty-ipc-spawn.ts` (`pty:spawn`) and `pty-runtime-controller.ts` (`runtime.setPtyController().spawn`) both assemble host env, Codex home, Claude auth, WSL distro, SSH env strip, pane reservation, persist, and restore-record seed. They already differ in ways that look historical but will now drift independently:

| Path | IPC `pty:spawn` | Runtime controller |
|------|-----------------|--------------------|
| Folder-workspace assert | yes (if no early stable owner) | yes (if not pre-adopted) |
| Missing-dir / WSL UNC cwd fallback | yes (`wslUncDirectoryExistsAsync`, `localStartupCwdDirectoryExists`) | **no** — `resolvePtySpawnStartupCwd(worktreeId, cwd)` only |
| `recoverFreshSpawnProviderRouting` | `sessionId === undefined` default | passes `args.isNewSession` |
| Agent Teams env refresh / launch-token admit | yes | no (caller pre-allocates handle) |
| `stripRemotePaneEnvWhenHooksDisabled` | yes | yes |

A later “fix spawn” that only lands in one file is a real SSH/WSL/folder regression. Split further by extracting **one** spawn-commit helper, not by copying more.

Other notes (not proven new vs monolith):

- `installPtyWriteIpcHandlers` does not `removeAllListeners('pty:write')`. Parent does, at the top of `registerPtyHandlers`. If installer order changes or a test calls the installer alone, write listeners double. `pty:claimViewport` removes inside the installer; `pty:write` does not.
- `finishPtyShutdown` still calls `markClaudePtyExited` after `clearProviderPtyState` (which already calls it). Duplicate, likely pre-existing.
- `pty-write-input.ts` redeclares inner `PtyWritePayload` / `PtyViewportClaimPayload` that shadow the exported types. No runtime effect.
- Headless shim still uses `isDestroyed: () => true`. Any scheduled `flushPendingData` then `releaseAll()` + clears pending. Same as before; more drain invalidations would hit it more often.

---

## 6. SSH / folder-workspace / WSL

These paths were moved, not obviously rewritten. Residual hazards:

**SSH**

- Encoded-owner routing in `getProviderForPty` still refuses local fallback for disconnected SSH ids.
- `pty:kill` / controller `kill` still tombstone via `finishPtyShutdown` when the SSH provider is gone.
- `hasPtyProviderForInspection` still treats missing SSH hosts as idle.
- Remote pane env is stripped in **both** spawn copies when hooks are off. Keep them identical.
- `writePtyInputAccepted` still returns false when `ptyOwnership.get(id) !== null` (SSH cannot ack). Local owners must be stored as `null`, not missing (`undefined !== null`).

**Folder workspace**

- `assertFolderWorkspacePtyPathUsable` now takes `store` and uses `getSshFilesystemProvider` for remote folder roots. Wired through register wrappers. Headless/no-store still no-ops (same as `!store` guard).

**WSL**

- `localStartupCwdDirectoryExists` still returns `true` for `\\wsl.localhost` (Win32 `statSync` false ENOENT).
- Only the IPC spawn path does async WSL directory existence + worktree cwd fallback. Runtime-created terminals (splits, CLI, headless) skip that. Do not “simplify” IPC spawn to match the controller.

**WSL Codex**

- Both spawn copies set `isWsl: shouldSkipCodexHomeEnvForWindowsShell(shell, cwd)` and `wslDistro` from `codexSelectionTarget`. `configure({ buildSpawnEnv })` in register still branches `ctx?.isWsl` for Codex target + `addOrcaWslInteropEnv`. Keep those three sites aligned.

---

## 7. `Record<string, any>` leftovers

**Pass.** No `Record<string, any>` in `src/main/ipc/pty.ts` or `src/main/ipc/pty/**`. Env maps are `Record<string, string>`. Casts are narrow (`providerGeneration?: number`), not `any`.

---

## 8. Folder + name + disables

**Pass.** Dest names are domain-specific. No `helpers` / `utils` / `common`. No `eslint-disable max-lines` / `oxlint-disable max-lines` on dest files.

---

## Required follow-up

1. Split `register-pty-handlers.ts` (2579), `pty-runtime-controller.ts` (1583), and `pty-ipc-spawn.ts` (1415) until every dest `wc -l` ≤ 400. Use plan B seams. Do not add max-lines disables.
2. Neutralize **all** session bridges at re-register start (`rebindProviderListeners` included), then retarget after the new session exists.
3. Dedup spawn preflight/commit before the two copies diverge on SSH env / WSL cwd / folder-workspace.
4. Make `installPtyWriteIpcHandlers` uninstall `pty:write` itself (same as `pty:claimViewport`).
5. Prune stale `inline src/main/ipc/pty.ts` from `config/max-lines-baseline.txt` after the barrel shrink.

Do not treat the 400-line work as optional. The mechanical contract (barrel, no dest→barrel, cwd wiring, no `any` records) is otherwise in place.
