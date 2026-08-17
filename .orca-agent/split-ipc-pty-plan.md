# Split `src/main/ipc/pty.ts` under 400 lines

## Baseline (Phase A)

- Branch: `split-ipc-pty` (clean)
- Source: `src/main/ipc/pty.ts` **7866** physical lines
- `pnpm run typecheck:node`: **pass**
- Focused tests: `pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/pty.test.ts` — **480 passed**
  - Note: `pnpm test -- src/main/ipc/pty.test.ts` does **not** filter. The test script is `ensure-native-runtime && vitest run`, so extra args go to the first command.

Hard size: source `wc -l` ≤ 400; every dest `wc -l` ≤ 400. Oxlint `.ts` max-lines is 300 counted (skip blanks/comments) and dest files must not add max-lines disables — keep dest files ~220–280 counted / well under 400 `wc -l`.

## Public API (keep on `src/main/ipc/pty.ts` barrel)

Consumers keep importing `./pty` / `../ipc/pty`. Do **not** add `src/main/ipc/pty/index.ts` (file+folder collision; same pattern as `src/main/github/project-view.ts`).

- `getBashShellReadyRcfileContent` (passthrough re-export)
- `isCurrentPtyExit`
- `getPtyIdForPaneKey`
- `registerPaneKeyTeardownListener`
- `hasPendingRendererSerializerForPaneKey`
- `BuildPtyHostEnvOptions`, `CodexHomeLaunchContext`, `GetSelectedCodexHomePath`, `PrepareCodexSessionResume`, `CodexHomePtySpawnedLifecycleArgs`
- `resolveCodexHomeAfterManagedAuthReadiness`
- `buildPtyHostEnv`
- `registerSshPtyProvider`, `unregisterSshPtyProvider`, `getSshPtyProvider`
- `getLocalPtyProvider`, `setLocalPtyProvider`
- `getPtyIdsForConnection`, `clearPtyOwnershipForConnection`
- `clearProviderPtyState`, `deletePtyOwnership`, `setPtyOwnership`, `restorePtyIncarnation`
- `rebindLocalProviderListeners`, `unbindLocalProviderListeners`
- `PtyRendererDeliveryDebugSnapshot`, `getPtyRendererDeliveryDebugSnapshot`, `resetPtyRendererDeliveryDebug`
- `registerPtyHandlers`, `registerHeadlessPtyRuntime`, `killAllPty`

Extracted modules import **siblings** (`./pty-provider-registry`), never the barrel.

## Dest files

### A. Module-level (lines 243–2361)

| Dest | Source range (approx) | Contents |
|---|---|---|
| `src/main/ipc/pty/pty-provider-registry.ts` | 243–260, 930–1018, 1981–2016 | `localProvider`, SSH maps, `getProvider*`, SSH/local register accessors |
| `src/main/ipc/pty/pty-ownership-state.ts` | 266–272, 2018–2042, 2123–2136 | ownership + incarnation maps and public mutators |
| `src/main/ipc/pty/pty-renderer-visibility-state.ts` | 262–286, 2157 | sizes, input/interactive, visibility sets, drain-invalidator bridges, `providerSnapshotRequiredPtys` |
| `src/main/ipc/pty/pty-pane-key-state.ts` | 288–321, 463–472, 511–519 | paneKey↔ptyId, teardown listeners, pane-key parse |
| `src/main/ipc/pty/pty-pane-serializer-state.ts` | 323–325, 459–461, 521–551, 918–928 | pending serializer gens + `hasPendingRendererSerializerForPaneKey` |
| `src/main/ipc/pty/pty-pane-spawn-reservation.ts` | 326–347, 554–637 | pane spawn reservations + runtime create claims |
| `src/main/ipc/pty/pty-agent-session-owners.ts` | 350–455 | claimed owners, restore-record seed, spawn-live assert |
| `src/main/ipc/pty/pty-launch-authority.ts` | 474–509 | renderer launch-token admit + Agent Teams refresh predicate |
| `src/main/ipc/pty/pty-stable-pane-owner.ts` | 640–916 | persist/resolve/attach/spawn stable pane owner |
| `src/main/ipc/pty/pty-provider-liveness.ts` | 968–1115 | remote-env strip, gone/live probes, `finishPtyShutdown` |
| `src/main/ipc/pty/pty-host-env-types.ts` | 1120–1144, 1242–1274 | public env/codex types, `ptyLifecycleSequence`, `PrepareClaudeAuth` |
| `src/main/ipc/pty/pty-host-env-path.ts` | 1146–1188 | PATH promote + env-key delete |
| `src/main/ipc/pty/pty-codex-home-env.ts` | 1190–1498 | Codex home skip/strip/readiness/account-route |
| `src/main/ipc/pty/pty-pi-agent-env.ts` | 1500–1693 | Pi/OMP/Mimo/OpenCode overlay env |
| `src/main/ipc/pty/pty-host-env.ts` | 1695–1926 | `buildPtyHostEnv` |
| `src/main/ipc/pty/pty-fresh-spawn-routing.ts` | 1928–1979 | Claude launch detect, daemon→local recovery, worktree spawn fence |
| `src/main/ipc/pty/pty-provider-state-cleanup.ts` | 2044–2121 | `clearProviderPtyState` |
| `src/main/ipc/pty/pty-provider-listener-lifecycle.ts` | 2138–2172, 2351–2360 | unsub slots, `rebind`/`unbind` |
| `src/main/ipc/pty/pty-renderer-delivery-debug.ts` | 2174–2271 | snapshot type + breadcrumb/power + get/reset |
| `src/main/ipc/pty/pty-renderer-lifecycle-reset.ts` | 2273–2348 | did-finish-load + lifecycle/gate reset handlers |

### B. `registerPtyHandlers` closure (2364–7825)

Cannot stay one function. Introduce `PtyIpcSession` (mutable per-registration object) so nested functions become modules that take `session`. Preserve setup order:

1. Cancel prior watchdog + neutralize prior closure bridges
2. Register renderer lifecycle reset
3. `ipcMain.removeHandler` / `removeAllListeners`
4. `LocalPtyProvider.configure`
5. Create pending drain queue + delivery state
6. Bind module-scope bridges (`invalidatePendingPtyDrain*`, debug snapshot readers, `rebindProviderListeners`)
7. `bindProviderListeners()`
8. `runtime.setPtyController(...)`
9. Register IPC handlers

| Dest | Contents |
|---|---|
| `src/main/ipc/pty/pty-ipc-session.ts` | Session type + `createPtyIpcSession` state (maps/timers/queues). Keep under 400 by splitting constants. |
| `src/main/ipc/pty/pty-delivery-constants.ts` | Batch/watermark/interactive constants |
| `src/main/ipc/pty/pty-local-provider-configure.ts` | `configure({ buildSpawnEnv, onSpawned, onExit, onData })` |
| `src/main/ipc/pty/pty-hidden-delivery-transition.ts` | hidden-delivery transition + spawn variant |
| `src/main/ipc/pty/pty-delivery-accounting.ts` | in-flight / ACK / credit / resync / write-off |
| `src/main/ipc/pty/pty-delivery-pending.ts` | pending append/drop/projection + overflow marker |
| `src/main/ipc/pty/pty-delivery-flush.ts` | `flushPendingData` + schedule + drain invalidation |
| `src/main/ipc/pty/pty-delivery-payload.ts` | payload builders, interactive-now, send-to-renderer |
| `src/main/ipc/pty/pty-delivery-accept.ts` | `acceptPtyDataForRenderer` |
| `src/main/ipc/pty/pty-exit-for-renderer.ts` | synthetic kill, retire, prepare/finalize/send exit |
| `src/main/ipc/pty/pty-provider-listener-bind.ts` | `bindProviderListeners` |
| `src/main/ipc/pty/pty-serialize-buffer.ts` | serialize request table + IPC response |
| `src/main/ipc/pty/pty-spawn-cwd.ts` | folder-workspace assert + startup cwd |
| `src/main/ipc/pty/pty-codex-resume-launch.ts` | prepare/resolve/reconcile resume + sequenced-argv strip |
| `src/main/ipc/pty/pty-adopt-stable-pane.ts` | `adoptStablePane` |
| `src/main/ipc/pty/pty-runtime-controller-spawn-preflight.ts` | controller spawn: auth, env, session id (part 1) |
| `src/main/ipc/pty/pty-runtime-controller-spawn-commit.ts` | controller spawn: persist, register, telemetry (part 2) |
| `src/main/ipc/pty/pty-runtime-controller.ts` | remaining controller methods (write/probe/attach/kill/list/serialize/resize) — split further if >400 |
| `src/main/ipc/pty/pty-runtime-controller-kill.ts` | kill / retireRejected / reversible stop |
| `src/main/ipc/pty/pty-ipc-spawn-preflight.ts` | `pty:spawn` handler preflight (cwd, auth, env) |
| `src/main/ipc/pty/pty-ipc-spawn-commit.ts` | `pty:spawn` persist/register/response |
| `src/main/ipc/pty/pty-ipc-write.ts` | write / writeAccepted / claimViewport |
| `src/main/ipc/pty/pty-ipc-resize-visibility.ts` | resize, geometry, ack, visibility, hidden, delivery interest |
| `src/main/ipc/pty/pty-ipc-inspect.ts` | kill/list/has/inspect/cwd/size/serializer IPC |
| `src/main/ipc/pty/pty-ipc-snapshot.ts` | getMainBufferSnapshot + sideEffectSnapshot + delivery debug IPC |
| `src/main/ipc/pty/register-pty-handlers.ts` | thin orchestrator: create session, run setup order, call installers |
| `src/main/ipc/pty/register-headless-pty-runtime.ts` | headless window shim |
| `src/main/ipc/pty/kill-all-pty.ts` | `killAllPty` |

If any dest exceeds 400 `wc -l` or 300 counted after paste, split again on the next domain seam (do not add a disable).

## Cycle / behavior risks

- Extracted files must not import `../pty` (the barrel). Sibling imports only.
- Re-registration must still allocate a **new** session and retarget module-scope bridges (`invalidatePendingPtyDrainPriority/Policy`, `rebindProviderListeners`, debug snapshot readers, dispatcher watchdog clearer). Do not lift session maps to module scope.
- Keep why-comments. SSH/folder-workspace/WSL/Windows/remote-wire paths stay verbatim.
- After shrink, **remove** the `eslint-disable max-lines` on `pty.ts` and prune `config/max-lines-baseline.txt` via `pnpm run check:max-lines-ratchet --prune` if the ratchet reports stale `inline src/main/ipc/pty.ts`.

## Verification

```bash
pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/pty.test.ts
pnpm run typecheck:node
pnpm run check:max-lines-ratchet
wc -l src/main/ipc/pty.ts src/main/ipc/pty/*.ts
```

Characterization tests: only if an extracted **pure** symbol is uncovered. Do not invent tests for IPC/session wiring already covered by `pty.test.ts`.

Commit (if green): `refactor: split pty.ts under 400 lines`
