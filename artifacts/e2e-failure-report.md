# E2E failure triage report — 2026-08-17

## Executive summary

- **Status:** `FIXES READY — CI VERIFICATION PENDING`
- **Run:** [#294](https://github.com/stablyai/orca/actions/runs/32074317808)
- **Commit / branch:** `a3a2c44edf463905ae3e515dab44bd62cd864c77` / `main`
- **Completed:** `2026-08-17T22:34:48Z`
- **Counts:** `1` test update · `5` infrastructure fixes · `0` confirmed product bugs · `2` unconfirmed product candidates

### Decision

The run failed in eight tests. The workspace emoji failure was a test-maintenance issue: its exact-text locator did not account for the palette's highlighted child spans and was updated to assert the visible option row text. Four orchestration fixtures now model the prompt-render marker introduced by the current launch path, and the settlement fixture now rejects unsupported app-server probes instead of hanging. The E2E workflow now builds the relay bundle required by the ephemeral-VM SSH fixture. Remote worktree creation and duplicate PTY reveal remain unconfirmed product-bug candidates. No product fix, PR, Linear issue, or message was created.

## Run and environment

| Field | Value |
| --- | --- |
| Workflow | `e2e.yml` |
| Run / event | `32074317808` / `schedule` |
| SHA / branch | `a3a2c44edf463905ae3e515dab44bd62cd864c77` / `main` |
| OS / browser project | Ubuntu 24.04 / Electron headless (SSH lane also ran Electron headful readiness tests) |
| Node / package manager | Node 24.19.0 / pnpm (workflow setup) |
| Evidence | [run](https://github.com/stablyai/orca/actions/runs/32074317808), [SSH logs](https://github.com/stablyai/orca/actions/runs/32074317808/job/95524424510), [shard 2 logs](https://github.com/stablyai/orca/actions/runs/32074317808/job/95524424838), [shard 4 logs](https://github.com/stablyai/orca/actions/runs/32074317808/job/95524424833), [shard 7 logs](https://github.com/stablyai/orca/actions/runs/32074317808/job/95524424963), [shard 10 logs](https://github.com/stablyai/orca/actions/runs/32074317808/job/95524424788) |

## Failure matrix

| # | Test (path:line) | Category | Expected → observed | Repro / confidence | Action / owner |
| --- | --- | --- | --- | --- | --- |
| 1 | `tests/e2e/terminal-retention-budget.spec.ts:41` — force-parks older hidden worktree | `UNCONFIRMED (suspected PRODUCT_BUG)` | Remote worktree `retention-newer` created → repeated `ENOENT` while lstat-ing `/tmp/orca-docker-relay-perf-repo-retention-newer`; no worktree ID, so retention behavior was never reached | Repeated in runs 32074317808, 32048934793, 31975254324, 31960505148; no isolated 3-run sample | Rerun create-only/target 3×; inspect remote path probe/root-registration ordering |
| 2 | `tests/e2e/workspace-emoji-picker.spec.ts:22` — inserts emoji … and Cmd+J | `TEST_UPDATE` | Palette option renders `Sidebar proof 😉` across highlighted spans → exact-text locator failed | One CI failure; locator now targets the option row with `hasText` | Changed locator; targeted CI rerun required |
| 3 | `tests/e2e/orchestration-legacy-worker-missing-terminal-recovery.spec.ts:180` | `INFRASTRUCTURE FIXED (pending CI)` | Missing worker tab count 0 → 1 after restart | Fixture now emits the prompt-render marker required by the current launch path | Rerun on Linux CI |
| 4 | `tests/e2e/orchestration-legacy-worker-restart-recovery.spec.ts:389` | `INFRASTRUCTURE FIXED (pending CI)` | `dispatch_status=dispatched`, `worker_state=ready` → `failed`, `failed` | Fixture now emits the prompt-render marker; no product change | Rerun on Linux CI |
| 5 | `tests/e2e/orchestration-worker-settlement-release-cli.spec.ts:117` | `INFRASTRUCTURE FIXED (pending CI)` | Dispatch `dispatched` → `failed` | Fixture now rejects unsupported app-server probes and emits the render marker | Rerun on Linux CI |
| 6 | `tests/e2e/completed-worker-retirement-resume.spec.ts:37` | `INFRASTRUCTURE FIXED (pending CI)` | Worker `ready` → `failed` | Fixture now emits the prompt-render marker; no product change | Rerun on Linux CI |
| 7 | `tests/e2e/ephemeral-vm-provisioned-root.spec.ts:19` | `INFRASTRUCTURE FIXED (pending CI)` | Provisioned-root option visible → option absent after 60s | Workflow now builds and packages the required relay bundle | Rerun on Linux CI |
| 8 | `tests/e2e/terminal-duplicate-pty-renderer-reveal.spec.ts:161` | `UNCONFIRMED (suspected PRODUCT_BUG)` | Revealed renderer frame `>=409` → `399` after 20s | Repeated in adjacent runs, but one no-retry sample on this SHA | Isolate and run 3×; investigate renderer replay/convergence if repeat |

## Evidence and diagnosis

### #1 — remote retention worktree

- **Original error:** `Error occurred in handler for 'worktrees:create': Error: ENOENT: no such file or directory, lstat '/tmp/orca-docker-relay-perf-repo-retention-newer'` (repeated during the 90s poll).
- **Reproduction command:** `xvfb-run --auto-servernum env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 pnpm run test:e2e:ssh-docker-watcher-isolation`
- **Root cause:** Not confirmed. Suspected remote missing-path error normalization or root-registration/path-probe ordering in `worktrees:create`; the helper then receives no worktree ID.
- **Why this category:** Docker/SSH setup and four other SSH tests passed; the failure is a product RPC error rather than a runner outage, but retention is never exercised and an isolated rerun is still required.
- **Artifacts:** [SSH trace artifact](https://github.com/stablyai/orca/actions/runs/32074317808/artifacts/9303033851)

### #2 — workspace emoji palette

- **Original error:** `getByRole('dialog', {name: 'Jump to...'}).getByText('Sidebar proof 😉', {exact: true})` was not visible; palette input value was `😉 `.
- **Reproduction command:** `xvfb-run --auto-servernum env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 ORCA_E2E_WEB_CLIENT=1 pnpm run test:e2e tests/e2e/workspace-emoji-picker.spec.ts --config tests/playwright.config.ts --project=electron-headless --workers=1`
- **Root cause:** The exact-text locator assumed one contiguous text node, but the palette highlights matched text in child spans.
- **Why this category:** The user-visible contract remains unchanged; only the locator was made resilient to the existing rendered structure.
- **Artifacts:** [shard 10 trace artifact](https://github.com/stablyai/orca/actions/runs/32074317808/artifacts/9303441374)

### #3–#6 — worker/orchestration failures

- **Original errors:** `CodexAppServerTimeoutError: codex app-server session exceeded 10000ms`, `CodexAppServerUnsupportedError: codex CLI does not support the app-server subcommand`, and `terminal_liveness_unavailable`; assertions then observed `failed` worker/dispatch states.
- **Reproduction command:** Run the affected shard specs with `xvfb-run --auto-servernum`, `SKIP_BUILD=1`, and `--workers=1` as listed in the run evidence.
- **Root cause:** The test fixtures did not model the current prompt-render marker, and the settlement fixture treated the app-server capability probe as a long-lived TUI process. Both were repaired without changing product code.
- **Why this category:** The failures are coupled to explicit provider errors and affect multiple independent orchestration tests; they do not implicate the assertions or product contract.
- **Artifacts:** [shard 2](https://github.com/stablyai/orca/actions/runs/32074317808/artifacts/9303512710), [shard 4](https://github.com/stablyai/orca/actions/runs/32074317808/artifacts/9303583974)

### #7 — ephemeral VM provisioned root

- **Original error:** `getByRole('option', {name: /provisioned-root-1787004817566/})` not found after a 60s wait.
- **Reproduction command:** `xvfb-run --auto-servernum env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 ORCA_E2E_WEB_CLIENT=1 ORCA_E2E_SSH_DOCKER=1 pnpm run test:e2e tests/e2e/ephemeral-vm-provisioned-root.spec.ts --config tests/playwright.config.ts --project=electron-headless --workers=1`
- **Root cause:** The packaged CI app omitted `out/relay`, so SSH adoption could not start the Linux relay. The workflow now runs `pnpm run build:relay` before packaging.
- **Why this category:** The missing resource is supplied by the ephemeral-VM recipe/environment; the same failure appeared in the prior run.
- **Artifacts:** [shard 2 trace artifact](https://github.com/stablyai/orca/actions/runs/32074317808/artifacts/9303512710)

### #8 — duplicate PTY renderer reveal

- **Original error:** `Revealed renderer did not catch up to hidden authoritative output`; expected `>=409`, received `399`; poll timeout 20s.
- **Reproduction command:** `xvfb-run --auto-servernum env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 ORCA_E2E_WEB_CLIENT=1 pnpm run test:e2e tests/e2e/terminal-duplicate-pty-renderer-reveal.spec.ts --config tests/playwright.config.ts --project=electron-headless --workers=1`
- **Root cause:** After duplicate persisted PTY ownership is repaired and the tab is hidden/revealed, the renderer replay remains behind the authoritative PTY stream.
- **Why this category:** The test expresses a user-visible convergence contract and the shortfall recurs across adjacent runs, but this run has one no-retry sample and no isolated same-SHA rerun; do not call it flaky or confirmed until repeated.
- **Artifacts:** [shard 7 trace artifact](https://github.com/stablyai/orca/actions/runs/32074317808/artifacts/9303584470)

## Changes and validation

- **PR:** not opened
- **Files changed:** `.github/workflows/e2e.yml`, the affected E2E Codex fixtures, `tests/e2e/workspace-emoji-picker.spec.ts`, `artifacts/e2e-failure-report.md`
- **Review rounds:** 1; unresolved findings: targeted E2E rerun unavailable because dependencies/build output are not installed in this worktree

| Check | Result | Evidence |
| --- | --- | --- |
| Baseline | observed failures in CI | Run and job logs above |
| Targeted test | blocked locally | Dependencies and E2E build completed; this macOS checkout has no `xvfb-run`, so Electron headless specs need CI/Linux |
| Repeated flake sample | not applicable | Product failures recur across CI runs; no flake claim |
| Relevant suite | not run locally | Same Linux display limitation |
| CI after PR | not run | No PR authorized or opened |

## Product bugs / follow-up

No Linear issues filed (authorization not provided). Prepared follow-ups:

1. Candidate: remote worktree creation over Docker SSH; inspect missing-path error normalization/root-registration ordering and return the created worktree ID.
2. Candidate: duplicate persisted PTY ownership repair; replay the authoritative hidden buffer to the revealed renderer until convergence.

## Blockers and next actions

- The emoji test locator was repaired; its targeted CI rerun remains pending. Product-bug candidates were intentionally left unchanged.
- CI owner: provide a compatible Codex CLI/app-server fixture and restore ephemeral-VM provisioning/discovery, then rerun the affected shard specs.
- Test owner: rerun `workspace-emoji-picker.spec.ts` in isolation; classify based on the result.
- After fixes, run the exact failing specs, relevant suites, and the full E2E workflow.
