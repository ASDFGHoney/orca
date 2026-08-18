# E2E failure triage and repair runbook

Use this runbook to investigate the newest GitHub Actions E2E run, repair failures that belong in code or tests, and produce an evidence-based report another engineer can act on.

## Operating rules

- Inspect the newest **completed** run of [the E2E workflow](https://github.com/stablyai/orca/actions/workflows/e2e.yml). Record its run ID, URL, commit SHA, branch, event, conclusion, and timestamp before changing anything.
- If the run completed successfully with no failed tests, publish a short `NO FAILURES` report and stop. If the workflow failed without a failed test (for example, setup, build, runner, or dependency failure), classify it as `INFRASTRUCTURE` and report the provider error instead of claiming a clean run.
- Preserve the original failure output, test file/line, browser/project, retry count, and relevant artifact or trace links. Never classify from a screenshot or one log line alone.
- Separate test maintenance, genuine flakiness, infrastructure/environment failures, and product defects. Infrastructure failures are a fourth outcome, not “flaky” by default.
- Keep fixes minimal and scoped to the failure. Do not update snapshots, increase timeouts, add retries, or weaken assertions without evidence that the existing contract is wrong.
- Redact tokens, cookies, credentials, personal data, and other secrets before publishing a report or sharing logs.
- External side effects (creating/merging a PR, filing Linear issues, or sending Slack messages) require authorization from the run owner unless this run was explicitly authorized for those actions. If not authorized, prepare the exact payload and stop before sending.

## 1. Identify the run and collect evidence

Use GitHub CLI or the GitHub UI. A CLI example:

```sh
gh run list --workflow e2e.yml --limit 10 \
  --json databaseId,status,conclusion,headSha,headBranch,event,createdAt,url
```

Select the newest run with `status=completed`. Then collect failed logs and, when present, artifacts:

```sh
gh run view <RUN_ID> --log-failed
gh run view <RUN_ID> --json jobs,artifacts,url,headSha,headBranch,event,createdAt,updatedAt
gh run download <RUN_ID> --dir <evidence-directory>
```

Skip `gh run download` when the run has no downloadable artifacts; the logs and job metadata are still sufficient for an infrastructure-only failure.

For each failure, capture:

1. The exact test title and source path/line.
2. The first meaningful assertion or error, not only the final teardown error.
3. Expected versus observed behavior, including relevant values.
4. Browser/project, OS, Node/package-manager versions, commit SHA, and worker/retry number.
5. Trace, screenshot, video, console, network, or application logs when available.
6. Whether another test failed first or shared setup was already unhealthy.

Group duplicate failures that share one root cause, but keep every affected test listed.

## 2. Classify with evidence

### Test needs update

Use this category only when the product behavior changed intentionally or the test encoded an obsolete contract. Confirm the new behavior from the implementation, product requirement, or an accepted PR—not from the failing test alone.

Typical fix: update a locator, assertion, fixture, seed data, or expected snapshot while retaining meaningful coverage.

### Flakiness

Use this category only when the same code sometimes passes and sometimes fails under the same conditions, or when a deterministic race/timing/resource issue is demonstrated. Re-run the narrow test at least three times when practical and record all outcomes. Prefer synchronization on a real readiness signal, deterministic test data, isolated resources, or cleanup fixes. Do not hide the problem with an arbitrary sleep or a blanket retry.

### Infrastructure/environment failure

Use this category for runner outage, dependency download failure, quota, authentication, browser installation, network, or host resource failures that do not implicate the test or product. Do not change product code. Record the provider error and whether a rerun succeeded; escalate to CI/infra ownership when needed.

### Product bug

Use this category when the test correctly expresses the expected contract and the product reproducibly violates it on the target commit. Do not “fix” the test to make the defect disappear. Capture a minimal reproduction, impact, suspected owner, and the first introducing PR if it can be established.

If evidence is insufficient, mark the item `UNCONFIRMED`, state the missing evidence, and do not land a speculative fix.

## 3. Repair and validate test-owned failures

For `TEST_UPDATE` and `FLAKY` items:

1. Reproduce the failure before editing. Save the command and baseline result.
2. Make the smallest deterministic change. Keep the test’s user-visible contract and diagnostic quality intact.
3. Run the exact failing test in isolation.
4. Run the nearest relevant file/project suite, then the full E2E command when feasible.
5. Run the test repeatedly for a flake fix (at least three consecutive passes; use more runs if the failure rate is low) and report the sample size.
6. Review the diff for unrelated changes, platform assumptions, leaked resources, and weakened assertions.
7. If the platform cannot run the test, say why and run every available static, unit, or equivalent validation instead. Never claim a pass that was not observed.

Recommended evidence table for each repair:

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Baseline reproduction | `<command>` | pass/fail | `<log or artifact>` |
| Targeted test | `<command>` | pass/fail | `<log>` |
| Repeated run (N) | `<command>` | N/N pass | `<log>` |
| Relevant suite | `<command>` | pass/fail | `<CI/local run>` |
| Full E2E (if run) | `<command>` | pass/fail | `<run URL>` |

## 4. Review loop and delivery gates

Use sub-agents by role: one collector for run evidence, one reproducer for independent confirmation, one fixer, one reviewer, and one CI monitor. Give edit ownership to a single agent/worktree at a time. A practical model split is a lower-cost model for collection, formatting, and polling, and a stronger model for diagnosis, implementation, and review (for example, `gpt-5.6-luna medium` versus `gpt-5.6-terra high` or `opus-5`). Parallelize independent read-only work, but do not let agents edit the same files concurrently without an explicit owner.

After the fix, have an independent reviewer inspect the diff, evidence, and classification. Address actionable findings and repeat the review for at most five rounds. Each round must state what changed or why a finding was rejected; “LGTM” without evidence is not a review.

Before opening a PR, require:

- targeted and relevant validation recorded;
- clean, focused diff and no secrets in the report or patch;
- reviewer approval with no unresolved actionable findings;
- explicit classification for every original failure.

For an authorized PR:

1. Create it from the run’s commit/branch context and include the failure, root cause, fix, and validation commands.
2. Monitor checks and review comments with `gh pr checks <PR>` and `gh pr view <PR> --comments`.
3. Fix actionable CI or review findings, rerun the affected validation, and repeat the review loop for at most five CI/review repair attempts total.
4. Do not merge while required checks are red, a review is unresolved, or the cause is still `UNCONFIRMED`.
5. Record the merged PR URL and merge SHA. If blocked, report the blocker and the next concrete action instead of looping forever.

For `PRODUCT_BUG` items, prepare or (when authorized) file one Linear issue per root cause with:

- title: `[P1] <concise user-visible defect>`;
- priority: `urgent`;
- label: `release-blocking`;
- assignee: the original PR owner only when verified;
- reproduction, expected/observed behavior, impact, evidence links, and suspected introducing commit.

Do not assign blame when ownership is uncertain; state `owner unknown` and explain how to identify it.

## 5. Build and share the report

Write the completed report to `artifacts/e2e-failure-report.md` (or another stable, repository-local path) using the template below. The artifact should contain only the report details and redacted evidence; do not include the agent transcript, credentials, edit tokens, or artifact-management instructions. Keep it self-contained: a reader should not need the agent transcript to understand the decision.

If the user has enabled public artifact publishing in Orca and is signed in, share the finished Markdown report:

```text
ORCA artifacts share ./artifacts/e2e-failure-report.md --json
```

Replace `ORCA` with the active Orca CLI executable for the current session. Capture the returned public `shareUrl` as delivery metadata; do not add it back into the artifact body. Publishing is gated by the human-controlled **Settings → Artifacts → Allow publishing public artifact links** setting. If sharing is disabled or fails authentication, do not retry. Send the report file as a follow-up attachment in the Slack thread instead, and explain the artifact failure. Never include `ORCA_CLOUD_AUTH_TOKEN` or edit tokens in logs.

Send the report to `#automations` only after authorization. Include the artifact URL when available, plus the run URL, one-line outcome counts, merged PR URL(s), Linear issue URL(s), and blockers. Capture the parent message URL returned by Slack so a fallback attachment can reply in its thread. Do not paste a wall of logs:

```text
E2E triage — <STATUS>
Run: <run URL>
Summary: <N> test updates · <N> flakes · <N> infrastructure · <N> product bugs
PRs: <links or none>
Linear: <links or none>
Report: <Orca artifact URL, or “artifact unavailable; see thread attachment”>
Blockers: <none or concise details>
```

When artifact sharing fails, reply in the same Slack thread with the local report file:

```text
agent-slack message send "<original Slack message URL>" "Artifact sharing failed; attaching the complete report." --attach ./artifacts/e2e-failure-report.md
```

## Report template

Copy this section into `artifacts/e2e-failure-report.md` and remove unused guidance in the final report.

```markdown
# E2E failure triage report — <YYYY-MM-DD>

## Executive summary

- **Status:** `NO FAILURES` | `FIXED` | `ISSUES FILED` | `BLOCKED` | `UNCONFIRMED`
- **Run:** [<run number>](<run URL>)
- **Commit / branch:** `<SHA>` / `<branch>`
- **Completed:** `<timestamp UTC>`
- **Counts:** `<N>` test updates · `<N>` flakes · `<N>` infrastructure · `<N>` product bugs

### Decision

<One paragraph: what failed, what was fixed or filed, and what remains blocked.>

## Run and environment

| Field | Value |
| --- | --- |
| Workflow | `e2e.yml` |
| Run / event | `<id>` / `<event>` |
| SHA / branch | `<sha>` / `<branch>` |
| OS / browser project | `<value>` / `<value>` |
| Node / package manager | `<value>` / `<value>` |
| Evidence | `<artifact, trace, or log links>` |

## Failure matrix

| # | Test (path:line) | Category | Expected → observed | Repro / confidence | Action / owner |
| --- | --- | --- | --- | --- | --- |
| 1 | `<test>` | `TEST_UPDATE` | `<...>` | `<N/M; high>` | `<PR or none>` |

## Evidence and diagnosis

### #<n> — <test title>

- **Original error:** `<quoted, redacted excerpt>`
- **Reproduction command:** `<exact command>`
- **Root cause:** `<specific cause, not a symptom>`
- **Why this category:** `<evidence and rejected alternatives>`
- **Artifacts:** `<trace/screenshot/log links>`

## Changes and validation

- **PR:** [<title>](<PR URL>) — merge SHA `<sha>` (or `not opened`)
- **Files changed:** `<paths>`
- **Review rounds:** `<N>`; unresolved findings: `<none or details>`

| Check | Result | Evidence |
| --- | --- | --- |
| Baseline | `<pass/fail>` | `<link>` |
| Targeted test | `<pass/fail>` | `<link>` |
| Repeated flake sample | `<N/N pass>` | `<link>` |
| Relevant suite | `<pass/fail/not run>` | `<link or reason>` |
| CI after PR | `<pass/fail/pending>` | `<link>` |

## Product bugs / follow-up

| Issue | Title | Priority / label | Assignee | Evidence |
| --- | --- | --- | --- | --- |
| [<LIN-123>](<URL>) | `[P1] <title>` | urgent / release-blocking | `<owner>` | `<links>` |

## Blockers and next actions

<Only concrete blockers, owners, and next commands. Write “none” when clear.>
```

## Completion checklist

- [ ] Newest completed run and commit recorded.
- [ ] Every failure has a category, evidence, and disposition.
- [ ] Test-owned changes have targeted and relevant validation.
- [ ] Flake claims include repeated-run results.
- [ ] Product bugs have reproducible steps and issue links, or a prepared payload.
- [ ] Review and CI gates are resolved or explicitly documented as blocked.
- [ ] Report is redacted and complete; it is shared through Orca artifacts or attached in the Slack thread when artifact publishing fails.
- [ ] Final handoff includes report URL/local path, PR URL(s), issue URL(s), and blockers.
