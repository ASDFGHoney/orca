# Split review (round 1): `src/main/ipc/pty.ts`

Mechanical review only. Dest files live under `src/main/ipc/pty/`. Barrel is `src/main/ipc/pty.ts`. Line counts are physical `wc -l` (last-line from file reads).

## Verdict

**Not done.** Barrel, naming, disable, and import-cycle checks pass. The 400-line hard cap fails on three dest files. The `registerPtyHandlers` closure was only partly extracted (plan B modules mostly still inline). No clear intentional runtime behavior change found in the extracted public wiring.

---

## 1. Move-only / no-logic-delta

**No intentional behavior change found** in the public API or in extracted module-level helpers that are actually wired (ownership, provider registry, cleanup, host env, headless/kill-all, write/snapshot/inspect installers).

Re-registration still:

1. Cancels the prior dispatcher watchdog and neutralizes drain/accounting bridges
2. Registers renderer lifecycle reset
3. Removes prior IPC handlers
4. Configures `LocalPtyProvider`
5. Allocates new closure-scoped delivery state (not lifted to module scope)
6. Retargets module-scope bridges
7. Binds provider listeners
8. Installs the runtime controller
9. Registers IPC handlers

New code is split plumbing (`setInvalidatePendingPtyDrain*`, `setRebindProviderListeners`, `installPty*` wrappers, `createPtyWriteInput`). `installPowerSignalBreadcrumbs()` still runs during handler registration (now from `installPtySnapshotIpcHandlers`, which `registerPtyHandlers` always calls).

### Findings

| Sev | Issue |
|-----|--------|
| Medium | `src/main/ipc/pty/pty-spawn-cwd.ts` is an unused copy. `assertFolderWorkspacePtyPathUsable`, `resolvePtySpawnStartupCwd`, and `localStartupCwdDirectoryExists` still live as closures in `register-pty-handlers.ts` and are passed into spawn/controller. Dest is dead; live copies can drift. Either switch callers or delete the dest. |
| Info | Plan B (`PtyIpcSession`, delivery/flush/accept modules, spawn preflight/commit splits) was not done. That is why the three oversized files remain. Not a behavior delta by itself. |

---

## 2. Folder + name

**Pass.** All dest files are under `src/main/ipc/pty/`. Names are domain-specific (`pty-ownership-state`, `pty-host-env`, `register-pty-handlers`, …). No `helpers` / `utils` / `common` / `misc`.

---

## 3. 400-line cap

**Fail.** Three dest files exceed 400 physical lines. Barrel is fine.

| File | `wc -l` | Cap |
|------|--------:|-----|
| `src/main/ipc/pty.ts` | 39 | ok |
| `src/main/ipc/pty/register-pty-handlers.ts` | **2616** | **FAIL** |
| `src/main/ipc/pty/pty-ipc-spawn.ts` | **1415** | **FAIL** |
| `src/main/ipc/pty/pty-runtime-controller.ts` | **608** | **FAIL** |
| `src/main/ipc/pty/pty-ipc-inspect.ts` | 320 | ok |
| `src/main/ipc/pty/pty-codex-home-env.ts` | 302 | ok |
| `src/main/ipc/pty/pty-stable-pane-owner.ts` | 294 | ok |
| `src/main/ipc/pty/pty-host-env.ts` | 271 | ok |
| `src/main/ipc/pty/pty-write-input.ts` | 210 | ok |
| `src/main/ipc/pty/pty-pi-agent-env.ts` | 204 | ok |
| remaining dest files | 12–137 | ok |

`register-pty-handlers.ts` still owns delivery accounting, pending flush, provider bind, cwd/codex-resume/adoptStablePane, and most resize/visibility/ack IPC. `pty-ipc-spawn.ts` and `pty-runtime-controller.ts` were not split on the plan seams (`pty-ipc-spawn-preflight` / `pty-ipc-spawn-commit`, `pty-runtime-controller-spawn-*` / `-kill`).

Oxlint counted max-lines is 300. `pty-ipc-inspect.ts` (320 physical) and `pty-codex-home-env.ts` (302 physical) may still trip counted max-lines even though they are under 400 `wc -l`. Split if ratchet/lint complains; do not add a disable.

---

## 4. No max-lines disables on new files

**Pass.** No `eslint-disable max-lines`, `oxlint-disable max-lines`, or per-file max-lines bump in `src/main/ipc/pty.ts` or `src/main/ipc/pty/**`.

---

## 5. Barrel / no `pty/index.ts`

**Pass.**

- `src/main/ipc/pty.ts` is re-exports only (public API matches the plan).
- No `src/main/ipc/pty/index.ts`.
- Consumers still import `./pty` / `../ipc/pty` (`pty.test.ts`, `daemon-init.ts`, `ssh-relay-session.ts`, `index.ts`, etc.).

---

## 6. Extracted files must not import the barrel

**Pass.** Dest files import siblings (`./pty-provider-registry`) or `src/main/ipc/*` neighbors (`../pty-hidden-delivery-gate`). No `from '../pty'`, `from '../../ipc/pty'`, or `from '.../ipc/pty'`.

---

## Required follow-up (before this split is complete)

1. Split `register-pty-handlers.ts` (2616), `pty-ipc-spawn.ts` (1415), and `pty-runtime-controller.ts` (608) until every dest `wc -l` ≤ 400. Use the plan B seams; do not add max-lines disables.
2. Wire or delete `pty-spawn-cwd.ts` so cwd helpers exist in one place.

Do not treat the 400-line work as optional. The rest of the mechanical contract is already in place.
