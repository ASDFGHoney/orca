# Mobile Hybrid WebView Simplification Audit

- **Status:** Proposed
- **Scope:** Reduce and validate the hybrid migration before release without
  changing the existing mobile UI or weakening its security boundaries.

## Goal

Determine whether the current implementation is the smallest maintainable
version of the chosen architecture. Remove proven dead or duplicate code,
consolidate validation infrastructure, and compare the handwritten bridge with
smaller designs before completing release certification.

The current comparison against `origin/main` contains 1,391 changed files,
139,997 additions, and 8,427 deletions. Approximately 68,000 additions are
production or configuration code; tests, validation scripts, and documentation
account for most of the remainder.

## Non-Negotiable Constraints

- Preserve the current mobile presentation and user-facing behavior from
  `main`.
- Keep the WebView origin isolated and the native bridge capability-based.
- Do not replace narrow authorization with an unrestricted RPC tunnel.
- Preserve Direct, Relay, SSH, WSL, folder workspace, mixed-version, iOS, and
  Android behavior.
- Do not remove tests until equivalent coverage exists in a consolidated form.
- Optimize concepts and attack surface, not an arbitrary line-count target.

## Parallel Review

Use `$orca-cli` to launch headed Codex CLI reviewers with `gpt-5.6-sol`. Review
workers must be read-only and return file/line evidence, deletion candidates,
risks, and proposed validation. The primary agent independently verifies every
finding before changing code.

Run these workstreams in parallel:

1. **Reachability and dead code:** cover native-shell and hosted-web entry
   points currently excluded by the repository Knip configuration.
2. **Bridge architecture:** review contracts, grants, broker dispatch, request
   clients, and subscriptions for generated or declarative replacements.
3. **Duplication and validation infrastructure:** find repeated production
   logic, fixtures, device launchers, and E2E scenario code that can become
   shared or table-driven.
4. **UI and runtime parity:** identify dual-runtime scaffolding and compatibility
   paths that can be removed without changing presentation or behavior.
5. **Native and security boundary:** minimize Swift/Kotlin and package-store
   code while retaining package verification, origin isolation, lifecycle, and
   rollback guarantees.

### Orca CLI Launch Pattern

Resolve the session's Orca executable according to the `$orca-cli` skill, then
load its version-matched guide with `orca skills get orca-cli`. On this macOS
worktree the current executable is `orca`.

For parallel read-only reviewers in the active checkout:

```text
orca status --json
orca terminal create --worktree active --title "Bridge review" --command 'codex --model gpt-5.6-sol' --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<bounded read-only review prompt>" --enter --json
```

Repeat with distinct titles and prompts for each workstream. Read results with
cursor-based `orca terminal read` calls. Do not send the same task to multiple
handles accidentally.

For approved implementation tasks, create isolated child worktrees and launch
the requested model explicitly because `worktree create --agent codex` cannot
select a Codex-specific model:

```text
orca worktree create --name <task-name> --parent-worktree active --json
orca terminal create --worktree id:<repoId>::<newWorktreePath> --title <task-name> --command 'codex --model gpt-5.6-sol' --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<bounded implementation prompt>" --enter --json
```

Only implementation workstreams with disjoint ownership may edit in parallel.
The primary agent reviews diffs, resolves shared-contract decisions, and runs
the integrated validation matrix.

## Architecture Comparison

Evaluate representative Tasks, Files, and Session slices under three designs:

1. The current handwritten capability bridge.
2. The same authorization model driven by one declarative operation registry
   that generates clients, grants, schemas, and dispatch wiring.
3. A smaller transport adapter that preserves more of the existing `RpcClient`
   interface behind a strict method allowlist.

Compare production lines, manually synchronized declarations, trusted code
size, failure handling, compatibility, test burden, and security properties.
Reject a smaller design if it broadens page authority or moves credentials into
the WebView.

## Execution Checklist

- [ ] Record exact `main` and candidate commits and regenerate the diff
      breakdown.
- [ ] Add migration entry points to a dead-code/reachability audit.
- [ ] Run and independently validate the parallel reviews.
- [ ] Remove confirmed dead files, exports, routes, and compatibility paths.
- [ ] Consolidate duplicate contracts, clients, dispatch, fixtures, and device
      scenarios where behavior remains explicit.
- [ ] Prototype the best smaller bridge design on representative feature
      slices and record the decision.
- [ ] Apply approved reductions in bounded, reviewable commits.
- [ ] Re-run typechecks, lint, unit/integration tests, package verification,
      emulator parity, security probes, and release gates.
- [ ] Publish before/after measurements and residual risks in the PR.

## Completion Criteria

- Every retained subsystem has a reachable production entry point or a
  documented release-validation purpose.
- One source of truth defines each bridge operation and its schemas, limits,
  authorization, and compatibility behavior.
- No unexplained duplicate production implementations remain.
- The current-main differential parity and security suites pass unchanged.
- The PR records why the resulting architecture was chosen over the smaller
  alternatives, not merely that CI passed.
