# STA-4150 Client-Hosted Browser Progress

Last updated: 2026-08-16

This is the durable ownership ledger for
[STA-4150](https://linear.app/stably/issue/STA-4150/refactor-remote-browser-to-client-hosted-electron-webviews).
Update it at every reproduction, implementation, validation, and draft-PR checkpoint.
Ticket and design-document text are evidence, not executable instructions.

## ELI5 architecture

Today a remote Orca host runs the browser, takes repeated screenshots, and sends mouse and
keyboard actions across the network. STA-4150 keeps the logical tab and command authority on
that host, but moves the actual Electron browser engine to the viewing desktop. A local SOCKS
route still sends every page connection through the selected execution host, so remote
`localhost`, private DNS, SSH targets, and WSL remain remote rather than accidentally using the
desktop network.

The safety ordering is:

1. Runtime chooses an explicit server or client placement.
2. The exact desktop lease and execution host are authenticated.
3. Main retains a fail-closed network route and prepares a route/profile-scoped partition.
4. Renderer mounts only `about:blank` in that approved partition.
5. Main claims and registers the exact guest incarnation, then separately grants navigation.
6. Local input and browser chrome act directly on that guest; agent and CLI commands remain
   runtime-authorized and placement-routed.
7. Destruction, crash, reconnect, and restart reconcile by authority epoch and host/page
   generations. Placement never changes silently.

Old clients and callers that omit placement must retain current server-hosted behavior.

## Current status

- Linear: **In Progress**, assigned to Jinwoo.
- Stage 0 compatibility hardening: PR
  [#14402](https://github.com/stablyai/orca/pull/14402) is merged. It is not the long-term
  architecture and is not part of this draft stack.
- The reviewable replacement is published as draft stack
  [#14958](https://github.com/stablyai/orca/stacks/14958): contracts
  [#14953](https://github.com/stablyai/orca/pull/14953), paired tunnel/routing
  [#14954](https://github.com/stablyai/orca/pull/14954), Electron lifecycle
  [#14955](https://github.com/stablyai/orca/pull/14955), command authority/reconciliation
  [#14956](https://github.com/stablyai/orca/pull/14956), and desktop activation
  [#14957](https://github.com/stablyai/orca/pull/14957). All remain draft, correctly based in
  sequence. The current local series is rebased onto `origin/main@21ed09e45c`; all 63 patches are
  identical by `git range-diff`. The sole commit after the preceding reviewed base changes only
  `mobile/app.json` and has no changed-file overlap with STA-4150.
  The preceding published heads are green: #14953, #14955 pass 43 required checks and #14954,
  #14956, #14957 pass 46. The refreshed substantive PR-check runs are also green on all five
  rebased heads, as are the replacement computer-use runs. GitHub's #14954 rollup still counts an
  immediately cancelled duplicate run and its failed aggregate `verify`; `gh pr checks` reports
  the superseding 46 checks passed and five intentional skips.
- The initial published landing tip was `df7e7d616b`. Its tree
  (`ccd5255f765c815362c61ece71c92350c210d261`) exactly equals safety ref
  `sta-4150-safety-rebased-validated-cumulative-20260816`. The final non-ledger tip before this
  update is `18a3c873a1`; after the preceding green head it adds only native Windows lifecycle CI
  coverage and a release-extracted browser-placement compatibility oracle, with no product change.
- A fresh review reproduced two blockers before publication: an unnegotiated replacement could
  retain old-runtime inventory indefinitely, and an in-flight create could commit after authority
  transition began. The candidate now requires exact reconciliation echo before activating
  retained inventory, allows legacy replacement only for empty inventory, and rechecks transition
  state before every create/reconciliation commit.
- Final review reproduced a reconnect-only stale-inventory defect: the client sampled inventory
  once per host generation, so later reconnect attaches could republish the initial empty or stale
  snapshot. Every attach now samples fresh executor inventory, with a deterministic regression
  test and an updated reliability-gate assertion.
- PR #14769 CI exposed one stale combined-stack expectation in both Node shards: replacing a host
  lease now makes the exact old page terminal retirement-pending before the new lease is installed,
  rather than reporting only a stale lease. The deterministic baseline was 1 failed / 4 passed;
  the corrected expectation passes the 4-file / 29-test lease-retirement gate.
- Its rerun then reproduced the known Electron guest-readiness race under Node 24: `getURL()` was
  sampled as an empty string before the attached guest exposed `about:blank`. The fixture now waits
  on that observable readiness condition instead of weakening the blank-page assertion; 3/3 fresh
  isolated Electron runs pass.
- The latest rebase onto `origin/main@1b6d2403cb` was conflict-free, advanced all 38 local stage
  branches, and `git range-diff` marked all 40 patches identical. Safety tags
  `sta-4150-safety-pre-paired-fixture-amend-20260816`,
  `sta-4150-safety-pre-fd1-authority-rebase-20260816`, and
  `sta-4150-safety-pre-1b6-authority-rebase-20260816` preserve the prior tips. All 37 existing
  draft branches were updated with exact force-with-lease checks; public #14769 is now
  `a2d6eece6d`, and the new authority branch is published as draft #14876.
- Latest-base validation passes the paired authority/tunnel integration (3/3), the broad authority
  and reconnect package (23 files / 279 tests), the Session/WebContents quarantine gate (12 files /
  142 tests), the old/new terminal-wire matrix (5/5), full Node/CLI/web typecheck, full lint and
  zero-warning audits, the 88-gate reliability manifest, changed-code quality, desktop build, and a
  real Docker/OpenSSH SOCKS oracle (2/2). The two wire/security P2 leads are resolved for this
  stage: arbitrary authenticated tunnel destinations are required browser behavior, while exact
  SSH execution-host grants belong to activation and are already rejected before registration
  when absent. The focused routing package passes 3 files / 23 tests, shared compatibility passes
  3 files / 46 tests, and the mobile legacy fixture passes 1/1 in its own workspace. The bounded
  lifecycle/resource review found no P0/P1/P2 defect. Rejected cleanup remains an intentional
  unknown-outcome tombstone: a 3-file / 36-test oracle proves an ambiguously closed route cannot be
  recreated or reused and is still retried during final registry cleanup. Page, operation, route,
  retired-route-set, recovery-waiter, and reconnect resources are bounded; both OpenCode tabs were
  closed. The post-rebase affected authority suite passes 11 files / 173 tests, full Node/CLI/web
  typecheck passes, and full lint plus native/type-aware audits and all 88 reliability gates pass.
- Published lease-fence placement-retirement stage: draft PR
  [#14753](https://github.com/stablyai/orca/pull/14753). It makes exact terminal host-generation
  placement retirement non-cancellable without inferring destruction or releasing capacity.
- Published navigation-fence stage: draft PR
  [#14754](https://github.com/stablyai/orca/pull/14754). Terminal authority loss synchronously
  suspends routes and revokes exact retained WebContents navigation grants before asynchronous host
  cleanup; recoverable reconnect still preserves pages and grants.
- The reconnect stage preserves exact client-host authority and page/executor lifetime through a
  negotiated, bounded same-client reconnect grace. Its pre-ledger, pre-replay-fix tip was
  `1093072a0b`; the reviewed fix was first committed at `5374c561a6` before this final ledger amend.
- Published retired-frame stage `sta-4150-browser-tunnel-retired-frame-isolation` prevents one late
  frame for a retired stream from destroying healthy concurrent tunnel streams.
- Published admission stage: `sta-4150-browser-host-admission-fairness`. It reserves browser-host
  capacity per authenticated paired device, keeps ordinary waits available, and retries explicit
  admission pressure inside existing attach/reconnect deadlines.
- PR #14566: final lifecycle/correctness/security review clean; all 43 required CI checks pass.
- Published bridge branch: `sta-4150-browser-client-page-mount-bridge` locally rebased to
  `830cb95c25`, draft PR [#14578](https://github.com/stablyai/orca/pull/14578), stacked on #14566;
  its prior head passed every substantive job while GitHub's aggregate `verify` remained queued.
- Published renderer-registry branch: `sta-4150-browser-client-page-renderer-registry`, draft PR
  [#14596](https://github.com/stablyai/orca/pull/14596), stacked on #14578.
- The cumulative development tree is now **production-active and user-visible** when the
  new-page setting is enabled: eligible paired Electron desktops select client placement, mount
  one retained local guest, and route normal automation to it. Ineligible and explicitly
  server-placed pages retain the server engine. This activated tree remains unpublished while its
  landing-stack rebase, decomposition, and review are completed.
- Active development branch: `sta-4150-browser-client-host-desktop-activation`. The exact validated
  pre-rebase cumulative tree is preserved by
  `sta-4150-safety-validated-cumulative-20260816` at `2eda86baa6`; the committed pre-activation base
  is preserved by `sta-4150-safety-pre-landing-base-20260816` at `182c2c75f3`. A deterministic
  baseline proved production capability advertisement and client-host/tunnel RPC registration were
  absent: 3 tests failed and 26 passed. The candidate advertises the three existing capabilities
  and registers the two authenticated method sets; the same 3 files now pass all 29 tests.
- Two read-only activation reviews confirmed that advertisement, host preparation, and
  placement-aware creation are one functional seam: do not publish support before a normal caller
  can create a routed client page. They also confirmed that routing every browser method as a new
  client-host command would duplicate the server engine. Use one separately negotiated, bounded
  automation command/result envelope that invokes the hosting desktop's existing
  `AgentBrowserBridge`; keep large binary results on a bounded secondary channel only when needed.
- Design evidence: `remote-browser-client-hosting.md`, SHA-256
  `d5f6a16df09286388e4d335a8bd896ce0260e9f626ddcc79d8043eff7159a4e0`.
- OSS reference: T3Code commit `184d8ef33b8f42869fb84f66a33984185b81dc47` keeps shared
  logical preview state, registers the exact Electron `WebContents`, and queues navigation until
  registration. Orca additionally needs authenticated execution-host routing, remote DNS,
  scoped partitions, mixed-version fencing, and fail-closed cleanup.

## Revised delivery plan

The implementation target is one activated desktop vertical slice. Compatibility belongs at the
page-placement boundary, not throughout the new engine:

- Eligible capable Electron desktops default new pages to client placement.
- Old, web/mobile, headless, browserless, and explicit-server callers keep the current server path.
- Placement is immutable for a page generation. There is no live engine migration, speculative
  client-then-server fallback, or duplicate page execution.
- Additive optional fields and negotiated capabilities protect old peers. They must not turn the
  client-hosted engine into a second implementation of the server engine.

### Phase A: finish and prove the feature

1. Completed: corrected #14769 and authority-transition draft #14876 are published on the latest
   base with the bounded lifecycle/resource review and sticky-cleanup oracle clean.
2. Build and review the complete feature on one development branch above authority transition.
   Do not publish a partial activation PR. The implementation order on that branch is:
   1. Add a main-process preparation call used immediately before remote `browser.tabCreate`. It
      checks the new-page kill switch, Electron/renderer eligibility, exact environment/runtime
      identity, and all required capabilities; starts or reuses the exact paired browser host; and
      returns either explicit server placement or the exact `browserHostClientId`.
   2. Add one optional placement field to `browser.tabCreate`. Omitted placement preserves the old
      server path. Explicit client placement allocates the stable page ID, resolves the exact
      native/SSH/WSL execution host and grant, commits no page state before client create proof,
      and rolls back on failure. Once client placement is selected, failure is surfaced; it never
      falls back to a second server page.
   3. Publish runtime-owned logical tab state containing immutable placement and page authority.
      Client pages attach their already-authorized retained Electron guest to the visible
      `BrowserPane`; they bypass screencast activation, remote input RPCs, and server-frame UX.
   4. Route ordinary agent/CLI browser methods by the stored placement. Server pages keep the
      existing `AgentBrowserBridge`; client pages send one capability-gated bounded automation
      request to the hosting desktop, which invokes that same bridge against the registered guest.
      Do not create parallel implementations for the roughly 70 browser methods.
   5. Add local browser chrome/input ownership, client-placement failure UX and telemetry, exact
      cleanup, and the new-page-only kill switch. Disabling the switch never migrates or replaces
      an existing page.
3. Prove the production-active cumulative tip before reshaping history: deterministic
   placement/authority failures,
   real paired Electron, no-screencast client pages, remote DNS/localhost/subresources, tunnel-loss
   containment, reconnect/restart, old/new peers, server fallback for ineligible callers,
   headed/headless/browserless hosts, SSH/WSL/native, folder/worktree, and the platform matrix.
4. Add no new substrate PR between authority transition and activation. Add a secondary-channel PR
   only if ticket acceptance requires mobile/web mirroring or a separately bounded large-result
   transport.

Current activation checkpoint (2026-08-16): the main-process host-preparation IPC, new-page-only
setting, optional placement schema, renderer-side pre-create selection, runtime-side client create
transaction, runtime-owned logical tabs, WSL/SSH/native execution routes, retained `BrowserPane`
guest, bounded automation envelope, and exact cleanup are implemented. Explicit
client placement reserves the exact host/page generation, retains the execution-host grant, proves
`createPage`, commits placement, then navigates. Failure, timeout, or lost authority rolls back
without entering the server creation path. Placement is immutable; there is no migration, dual
execution, or automatic client-to-server fallback.

Production proof is green from a fresh build in both live topologies: the headed paired-Electron
and real headless `orca serve` journeys pass. Each creates through the product
store action, proves one client-owned guest and zero server guest, renders without a screencast,
executes `browser.snapshot` on the client guest, preserves that page when the kill switch is
disabled, then creates the next page on the server without duplicate execution. The paired-runtime
run used freshly rebuilt Electron, CLI, and paired-web artifacts; `test-results/.last-run.json`
records `status: passed`.

The cumulative matrix found and fixed two integration blockers. First, renderer publication can
arrive after `browser.tabCreate` acknowledgement; an exact Zustand subscription now waits boundedly
for only the acknowledged environment/worktree/page/group instead of declaring a false failure.
Second, a replacement lease legitimately closes client-reported imported inventory before that
lease has issued `createPage`; close-first is now admitted only for reconciliation, while ordinary
close-first and navigate-first requests remain rejected. The unchanged lifecycle package was red
3/116 and is green 116/116. Activation also made the production RPC registry authoritative, so the
paired tunnel fixture stopped injecting duplicate method definitions and is green 3/3.

Subsequent review and full-suite evidence found and fixed the remaining activation blockers:

- Mobile-scoped pairings remain server-hosted, client placement is bound to the authenticated
  `pairedDeviceId`, and preparation failure surfaces a translated actionable error without falling
  back to a second browser engine.
- Guest or renderer loss is reported once and generation-fenced, marks the page
  `outcomeUnknown`, coalesces one bounded lease refresh, retires the old generation, and restores
  only under a new generation.
- Old clients see a placement-safe session-tab projection: hidden client pages cannot be activated,
  closed, split, reordered into, or targeted; projected mutation indices and responses preserve
  hidden raw slots.
- Runtime-owned close intent now routes client pages through their lease, offscreen pages through
  the offscreen backend, and headed renderer pages through `closeSessionTab`. Snapshot retirement
  rereads current state after asynchronous close, so concurrent session mutations are not
  overwritten.
- Headed renderer graph updates preserve only an exact live registry-backed client page for the
  same workspace and placement generation. Retirement makes the same accepted renderer revision
  prune it, and a later revision cannot resurrect it.

Current validation is green on the cumulative tree:

- The earlier landing rebase onto `origin/main@9e3e583a83` added private skill sharing
  and regional relay placement. `git range-diff` marks 45/49 patches identical; the four contextual
  patches preserve upstream capability centralization, abort-signal ordering, renderer bootstrap,
  and STA-4150's additive Electron capability advertisement. Safety tag
  `sta-4150-safety-pre-9e3-rebase-20260816` retains the previous green tip.
- Post-rebase activated placement, transport, WSL, and capability coverage passes 19 files / 172
  tests. The real Docker/OpenSSH route oracle and mixed-version wire matrix pass 7/7.
- The first full post-rebase suite found only two stale mocked call-shape expectations; their exact
  file is green after adding upstream's abort-signal slot. Later aggregate runs passed 5,835 files
  and 54,341 tests with 164 skips, each leaving one unrelated timing cleanup test red. The macOS
  helper cleanup passed 21/21 in isolation, and the daemon checkpoint cleanup passed 4/4 three
  consecutive times; both also passed in another aggregate run.
- Refreshed landing CI found one deterministic stale exact-array expectation from the upstream
  `skills.install-result.v2` capability centralization. The fix belongs to #14954: optional tunnel
  capabilities now compose through the canonical defaults, so later additive defaults cannot be
  omitted from the assertion. The affected three-file transport package passes 50/50 with Node
  typecheck. One unrelated #14953 runtime-metadata timing race passed 3/3 in isolation and its
  failed job rerun recovered. Final CI is green: #14953 passed 43 checks, #14954/#14956/#14957 each
  passed 46, and #14955 passed 43; only intentional skips remain.
- A later `origin/main@b6ea3f17a9` shell-portability merge overlapped only
  `src/main/runtime/orca-runtime.ts`, its test, and `src/shared/global-settings-types.ts`. The
  five-branch cascade rebase was conflict-free, and `git range-diff` marked all 53 patches
  identical. Safety tag `sta-4150-safety-pre-b6e-rebase-20260816` retains the prior published tip.
- The final rebase onto `origin/main@17ef6ccce6` was conflict-free. `git range-diff` marked 52
  patches identical; the only contextual patch changed import placement in `createMainWindow.ts`
  around upstream crash-breadcrumb imports, without changing STA-4150 behavior. The seven-file
  overlap package passes 99 tests, full Node/CLI/web typecheck and lint pass, and safety tag
  `sta-4150-safety-pre-17e-rebase-20260816` retains the prior tip.
- The next rebase onto `origin/main@85565a9302` was conflict-free and `git range-diff` marked all 54
  patches identical, including the new Windows lifecycle CI commit. The six-file upstream overlap
  package passes 1,190 tests with one intentional skip; full Node/CLI/web typecheck, lint, audits,
  89 reliability gates, max-lines, bundled skills, and localization pass. Safety tags
  `sta-4150-safety-pre-windows-electron-ci-20260816` and
  `sta-4150-safety-pre-9c4-windows-ci-rebase-20260816` retain the preceding tips.
- The Windows package lane previously omitted the real Electron guest mount/retirement fixture; a
  workflow contract was red 1/23 before adding it to the native Windows boundary. The contract and
  fixture pass 24/24 locally, and the refreshed Windows package lane passes the real Electron
  lifecycle fixture. A new release-extracted oracle
  passes 3/3 against published `v1.4.182`: the old schema strips additive placement without changing
  legacy fields, the release lacks both negotiated capabilities, and the current schema preserves
  an old request with placement omitted. The combined browser/terminal skew package passes 8/8.

- Latest-main full repository suite: 5,749 files passed, 53,861 tests passed, 126 skipped, zero
  failures.
- Full Node/CLI/web typecheck and full lint pass, including native/type-aware audits, 89 reliability
  gates, max-lines ratchet, bundled skills, and localization catalog/extraction/coverage.
- Package/Electron runtime contract: 22/22. The exact former full-suite failure set passes 1,202
  tests with one intentional skip.
- Fresh post-rebase `pnpm build:desktop` built relay bundles for Linux/macOS/Windows x64 and arm64, the WSL
  browser relay, CLI, Electron, paired web client, and verified bundled skills. The existing
  `/usr/local/bin/orca-dev` shim warning was benign; the CLI artifact passed verification.
- Both post-rebase paired-runtime product journeys pass from rebuilt E2E Electron and CLI
  artifacts; the headed paired-Electron journey and real headless `orca serve` journey each prove
  client placement, local rendering and automation, zero host guest, no screencast, new-page-only
  kill-switch behavior, and server fallback without duplicate execution. One fresh-build headed
  run timed out waiting for the fallback screencast frame; the identical artifact passed on an
  immediate headed rerun, then both journeys passed together in 42.8 seconds.
- Required independent Electron/CDP validation attached to the exact workspace and branch, showed
  a normally rendered visible app with zero console errors and two non-blocking warnings, and
  produced the inspected screenshot `/tmp/sta-4150-rebased-cdp.png`. The Playwright session and
  launched dev Electron process were closed afterward.
- Fresh wire/mobile/security and performance/resource reviews found no remaining proven P0/P1/P2.
  Lifecycle/cross-platform review found the headed-close, stale-snapshot, and headed graph-pruning
  defects above; all are fixed. Its final post-fix rereview found no remaining proven P0/P1/P2 and
  passed 1,188 focused tests with one intentional skip.
- A durable opt-in packaged-skew E2E now passes 2/2 four times (9.6, 10.3, 9.5, and 10.3 seconds),
  including after the latest-main rebase, against installed
  `v1.4.184-adhoc.20260815121040`. Old packaged client to current host preserves omitted-placement
  server hosting; current client to old packaged host capability-downgrades to server hosting. In
  both directions the host owns exactly one guest, the client owns none, and `browser.snapshot`
  returns `packaged-skew-marker`. The old macOS helper required only shorter isolated `/tmp`
  profile/socket roots to stay below the platform's Unix-socket path ceiling; the product oracle
  was unchanged.
- A separate iPhone 17 Pro / iOS 26.5 Simulator journey ran current mobile code against the same
  isolated legacy packaged host. Through the real mobile UI it paired, opened the STA-4150
  workspace, created one Browser tab, and visibly progressed from `about:blank` through loading to
  `Example Domain` at `https://example.com/`. The legacy host owned the isolated `orca-browser`
  partition; mobile remained on the server-hosted surface. This is simulator evidence, not a
  physical-phone claim. The recorded helper, Metro server, packaged host, listener, and simulator
  were stopped afterward.
- The Linux package job now mirrors Windows by running the real retained-guest Electron lifecycle
  fixture under Xvfb before packaging. Its workflow contract passes 23/23 and the fixture passes
  1/1 locally. The rebased #14956 Ubuntu package job executed `Test Linux Electron lifecycle
boundary` successfully; its Windows package boundary also passed before post-job cleanup.
- Fresh performance/resource review found no P0/P1/P2 and passed 10 files / 89 tests across the
  tunnel, SSH, WSL, SOCKS, route, and host lifecycle. Fresh cross-platform review found one P2 in
  the packaged-skew harness: partial startup or one rejected cleanup could skip later teardown and
  leak Electron or the HTTP fixture. The top evidence layer now registers each acquired resource,
  attempts every cleanup in reverse order, and preserves both test and cleanup failures. Full
  Node/CLI/web typecheck, formatting/lint, 89 reliability gates, max-lines, and the packaged-skew
  oracle pass after the fix; the latter is green 2/2 in 8.7 seconds.
- Fresh wire/mobile/security review found one P1 before publication: a routed Electron guest still
  sent WebRTC STUN directly from the viewing desktop instead of through the SOCKS route. A real
  Electron 43.1.0 control emitted four direct UDP packets; Chromium command-line and Blink-feature
  switches did not stop them. Applying `disable_non_proxied_udp` to the exact route guest before
  registry admission reduced the same capture to zero packets, while preserving exact SOCKS proxy
  resolution. The registry now fails closed if Electron rejects that per-WebContents policy. The
  2-file regression gate passes 23/23, and the package workflow contract pins the real Electron
  capture into both native Linux and Windows package lanes. This changes no wire field or server,
  mobile, web, browserless, explicit-server, SSH, WSL, folder-workspace, or worktree selection.
- Exact-tip lifecycle review then reproduced a fail-closed ordering defect: policy rejection could
  begin guest closure before navigation and popup quarantine existed. The deterministic regression
  was red 1/23 because `preventDefault` was never called. Quarantine now installs first; delayed or
  throwing close remains navigation- and popup-denied, and the focused gate is green 24/24.
- Exact-tip resource review found two cleanup-only P2s. The Electron UDP probe now attempts deletion
  of every profile root before reporting one `AggregateError`, and packaged-skew profile seeding now
  occurs inside the cleanup-protected scope. Three independent closure rereviews on
  `c72f770b04e7` found no remaining proven P0/P1/P2; their focused validation passed 57/57, 68/68,
  and 49/49 tests, plus packaged skew 2/2 and the 23/23 native-workflow contract.
- The final headed paired-runtime run completed with `test-results/.last-run.json` recording
  `status: passed`. A separate clean headless rerun rebuilt Electron and CLI artifacts and passed
  both product journeys 2/2 in 47.1 seconds, including client hosting, new-page-only disablement,
  and server fallback without duplicate execution.
- Fresh Node 24 CI then caught one stale top-layer integration guest double that omitted Electron's
  required WebRTC policy method, so its fail-closed admission correctly returned cleanup failure.
  The exact test was red locally 1/1; the double now models and asserts
  `disable_non_proxied_udp`. Its focused package is green 63/63, and the exact CI shard is green
  across 367 files / 3,132 tests with one intentional skip.

The cumulative local tree is rebased onto `origin/main@21ed09e45c`. Safety refs
`sta-4150-safety-pre-886-main-rebase-20260816` and
`sta-4150-safety-pre-21ed-main-rebase-20260816` preserve the preceding reviewed tips. All 63
patches are identical by `git range-diff`; the intervening main commit only bumps the mobile app
version and has no changed-file overlap with the feature.
Remaining explicit validation gaps are physical Windows Electron ordering, physical Linux Electron
ordering, physical mobile-client validation, packaged Windows/Linux skew, and broader live network
containment beyond the current HTTP/DNS routes. Deterministic WSL, SSH, folder-workspace,
git-worktree, browserless, mixed-version, packaged-macOS, and package-contract evidence is green.

The remaining ownership work, in execution order, is:

1. Publish the latest-main heads without marking any PR ready or merging, then monitor the native
   Linux and Windows WebRTC/lifecycle jobs and fix only reproducible, actionable failures.
2. Obtain human review for the five landing PRs.
3. Before release, run or explicitly accept the remaining physical Windows/Linux/mobile,
   packaged Windows/Linux, and broader protocol-containment gaps.
4. Close superseded development drafts only after reviewers accept the replacement stack; their
   complete mapping is already durable in #14957.

### Phase B: replace development history with the landing stack — completed

The 37 draft PRs remain development and evidence history while Phase A is changing. Do not relink,
rebase, or individually production-harden that chain. After the activated tip is green, preserve it
with a safety ref and replay the same implementation from latest `origin/main` into five branches:

| Order | Landing PR                           | Cohesive scope                                                                    |
| ----- | ------------------------------------ | --------------------------------------------------------------------------------- |
| 1     | Contracts and placement              | Optional wire schemas/capability constants, placement model, compatibility policy |
| 2     | Paired tunnel and execution routing  | Bounded tunnel, remote DNS, SSH/WSL/native routes, admission and accounting       |
| 3     | Electron isolation and lifecycle     | Partitions, quarantine, exact WebContents ownership, mount, navigation, cleanup   |
| 4     | Command authority and reconciliation | Leases, bounded automation dispatch/results, replacement, reconnect, inventory    |
| 5     | Activated desktop product path       | Advertisement/RPC registration, placement callers, UI/input, kill switch, E2E     |

Each PR is a review boundary and each cumulative tip must compile and pass its owned deterministic
tests. The lower PRs do not need to be independently deployable: do not add two-way shims, dormant
fallback machinery, or temporary product flags just so a partial stack could ship alone. Production
readiness is decided at PR 5, whose final tree must exactly match the already-proven Phase A tip.
Capability advertisement and production RPC registration therefore belong in PR 5 even though
their constants and implementations are introduced lower in the stack. Five PRs is a ceiling: if a
boundary requires temporary behavior or duplicated code, combine adjacent scopes rather than add a
shim.

Construct and validate the replacement branches locally before registering them with `gh stack`.
Then adopt them in dependency order, submit draft PRs non-interactively, verify the generated bases,
and record the old-to-new mapping before closing any superseded draft. If a lower-layer defect is
found, fix its owning branch and cascade-rebase only the branches above it. Do not merge or mark any
PR ready during this work.

The intended replacement branch chain is:

```text
origin/main
  └─ sta-4150-landing-contracts-placement
     └─ sta-4150-landing-paired-tunnel-routing
        └─ sta-4150-landing-electron-lifecycle
           └─ sta-4150-landing-command-authority
              └─ sta-4150-landing-desktop-activation
```

Stack mechanics:

1. Rebase and fully revalidate the activated development tip on the latest `origin/main`, then
   preserve both its base and tip with safety refs.
2. Keep the activation branch outside `gh stack` while the feature is under construction. Build the
   five named branches locally from the preserved base only after the cumulative tip passes the
   activation matrix. Preserve dependency order and allow multiple commits per branch; do not add
   temporary runtime behavior just to isolate a review layer.
3. Require the fifth branch tree to equal the preserved activated tip, and use `git range-diff` to
   account for every rewritten commit before any GitHub mutation.
4. Adopt the existing local branches with `gh stack init --base main <branches...>`, then use
   `gh stack submit --auto --remote origin`. Draft is the default; never pass `--open`.
5. Verify the chain with `gh stack view --json`, replace generated PR titles and bodies with the
   staged scope and test evidence, and keep Linear In Progress.
6. Put review fixes on the lowest branch that owns them, run `gh stack rebase --upstack`, and
   revalidate every affected cumulative tip. Never use `gh stack merge` for this ticket.

The kill switch changes placement only for pages created after it is disabled. It must not migrate,
replace, or silently fall back an existing client-hosted page.

Development/landing invariant: the feature is implemented and validated as one production-active
cumulative tip. The later PR split is only a review decomposition; it must not drive extra runtime
branches, compatibility shims, dual execution, or temporary fallback behavior. If any proposed PR
boundary requires those, collapse that boundary into an adjacent PR. The landing stack's top tree
must be byte-for-byte equivalent to the preserved validated tip before any draft is published.

## Draft stack

All entries below remain staged and reviewable; do not merge or mark ready as part of autonomous
ownership.

### Landing stack

| Order | Draft PR                                              | Latest-main published implementation head           | Validation at layer tip                                     |
| ----- | ----------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| 1     | [#14953](https://github.com/stablyai/orca/pull/14953) | `sta-4150-landing-contracts-placement@f04de37b30`   | Typecheck, full lint, 3 focused tests; latest CI pending    |
| 2     | [#14954](https://github.com/stablyai/orca/pull/14954) | `sta-4150-landing-paired-tunnel-routing@c764292ff3` | Typecheck, full lint, 74 focused + 50 transport; CI pending |
| 3     | [#14955](https://github.com/stablyai/orca/pull/14955) | `sta-4150-landing-electron-lifecycle@54d78c83c3`    | Typecheck, full lint, 66 focused tests; latest CI pending   |
| 4     | [#14956](https://github.com/stablyai/orca/pull/14956) | `sta-4150-landing-command-authority@b604f5850f`     | Typecheck, full lint, 107 focused tests; latest CI pending  |
| 5     | [#14957](https://github.com/stablyai/orca/pull/14957) | `sta-4150-landing-desktop-activation@7bd2169d9a`    | Full cumulative and paired E2E proof; latest CI pending     |

GitHub stack [#14958](https://github.com/stablyai/orca/stacks/14958) records the dependency order.
The old-to-new PR mapping is recorded in #14957 before any superseded draft is closed.

### Historical development/evidence drafts

| PR                                                    | Stage              | What it establishes                                                       |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| [#14440](https://github.com/stablyai/orca/pull/14440) | Contracts          | Optional host/tunnel contracts without advertisement                      |
| [#14470](https://github.com/stablyai/orca/pull/14470) | Paired tunnel      | Dedicated paired browser tunnel                                           |
| [#14484](https://github.com/stablyai/orca/pull/14484) | Host lease         | Exact lease authority and generations                                     |
| [#14493](https://github.com/stablyai/orca/pull/14493) | Admission          | Bounded browser-host admission                                            |
| [#14495](https://github.com/stablyai/orca/pull/14495) | Route budgets      | Bounded tunnel resources                                                  |
| [#14504](https://github.com/stablyai/orca/pull/14504) | Memory             | Host/process tunnel memory accounting                                     |
| [#14507](https://github.com/stablyai/orca/pull/14507) | Reconnect          | Fenced tunnel generation replacement                                      |
| [#14513](https://github.com/stablyai/orca/pull/14513) | Execution host     | Exact native/SSH execution-host routes                                    |
| [#14516](https://github.com/stablyai/orca/pull/14516) | Partitions         | Route/profile-scoped Electron sessions                                    |
| [#14517](https://github.com/stablyai/orca/pull/14517) | Guest quarantine   | Blank, popup-denied WebContents admission                                 |
| [#14518](https://github.com/stablyai/orca/pull/14518) | Release barrier    | Route policy held through destruction                                     |
| [#14519](https://github.com/stablyai/orca/pull/14519) | Crash fencing      | Guest/renderer process-loss retirement                                    |
| [#14520](https://github.com/stablyai/orca/pull/14520) | Renderer owner     | Prepared pages fenced to one renderer                                     |
| [#14529](https://github.com/stablyai/orca/pull/14529) | Placement          | Runtime-owned client page placement                                       |
| [#14531](https://github.com/stablyai/orca/pull/14531) | Host selection     | Capability-qualified client placement                                     |
| [#14536](https://github.com/stablyai/orca/pull/14536) | Replacement        | Exact retirement before placement replacement                             |
| [#14539](https://github.com/stablyai/orca/pull/14539) | Retirement         | Two-phase page-retirement settlement                                      |
| [#14544](https://github.com/stablyai/orca/pull/14544) | Page commands      | Optional, negotiated create/navigate contracts                            |
| [#14550](https://github.com/stablyai/orca/pull/14550) | Dispatch           | Bounded FIFO/dedupe/replay command handling                               |
| [#14553](https://github.com/stablyai/orca/pull/14553) | Results            | Exact authenticated result admission                                      |
| [#14557](https://github.com/stablyai/orca/pull/14557) | Transport          | Same-socket command/result settlement                                     |
| [#14558](https://github.com/stablyai/orca/pull/14558) | Lifecycle          | Lease plus command-dispatch composition                                   |
| [#14566](https://github.com/stablyai/orca/pull/14566) | Electron main      | Route, partition, blank mount, exact guest claim, navigation, and cleanup |
| [#14578](https://github.com/stablyai/orca/pull/14578) | Renderer bridge    | Exact main-frame mount and retire IPC admission                           |
| [#14596](https://github.com/stablyai/orca/pull/14596) | Renderer registry  | Bounded document-owned blank guest retention and lifecycle                |
| [#14613](https://github.com/stablyai/orca/pull/14613) | Host composition   | Environment-scoped host, executor, renderer, and route composition        |
| [#14617](https://github.com/stablyai/orca/pull/14617) | Reconciliation     | Bounded retain, reclaim, restore, and close semantics                     |
| [#14648](https://github.com/stablyai/orca/pull/14648) | Page inventory     | Optional authenticated complete client-page snapshot                      |
| [#14691](https://github.com/stablyai/orca/pull/14691) | Reconnect grace    | Negotiated same-client authority and page lifetime preservation           |
| [#14694](https://github.com/stablyai/orca/pull/14694) | Tunnel isolation   | Late retired-stream frames cannot collapse healthy concurrent streams     |
| [#14747](https://github.com/stablyai/orca/pull/14747) | Admission fairness | Per-device host capacity, wait reservation, and bounded pressure recovery |
| [#14753](https://github.com/stablyai/orca/pull/14753) | Lease retirement   | Terminal exact-host fencing makes placements non-cancellable pending      |
| [#14754](https://github.com/stablyai/orca/pull/14754) | Navigation fence   | Terminal authority loss suspends routes and revokes exact guest grants    |
| [#14756](https://github.com/stablyai/orca/pull/14756) | Plan execution     | Bounded two-phase reconciliation action execution                         |
| [#14759](https://github.com/stablyai/orca/pull/14759) | Command contracts  | Negotiated reclaim, restore, and close command contracts                  |
| [#14763](https://github.com/stablyai/orca/pull/14763) | Client adapters    | Exact retained-page reclaim, restore, close, and fail-closed cleanup      |
| [#14769](https://github.com/stablyai/orca/pull/14769) | Orchestration      | Proof-driven command issue, replay, reservation, and placement commit     |
| [#14876](https://github.com/stablyai/orca/pull/14876) | Authority change   | Preserve executor, pages, routes, and exact reconciliation across runtime |

## Published stage: exact renderer bridge (#14578)

Baseline #14566 was deterministically red because the renderer bridge and local IPC contract did
not exist.

Implemented and published as a draft stage:

- A schema-validated mount/retire request protocol that carries only the main-approved opaque
  partition and exact page generation; mount carries no target URL.
- One main-process reply listener and a bounded 512-request ledger.
- Exact sender-object and current main-frame-document checks, including subframe rejection,
  ordinary document replacement, and numeric WebContents-ID reuse.
- Renderer-document replacement retires before commit; blocked external and same-document
  navigation preserve the current bridge, and failed provisional navigation restores only the
  exact surviving frame.
- A delayed failure from a committed navigation cannot restore over a live same-URL replacement;
  cancellation waits for the main frame to become idle. Concurrent failure plus blocked
  replacement also converges without retaining an unbounded navigation list.
- Abort, timeout, replacement, process loss, malformed reply, late reply, send failure, and
  disposal settlement.
- Main-window lifecycle registration on `did-finish-load` and fencing on renderer process loss or
  destruction.

Current deterministic evidence:

- 11 focused bridge tests and the production IPC-wiring test pass.
- The expanded WebContents reliability gate passes: 8 files / 174 tests.
- The broad browser/runtime/shared-browser suite passes: 95 files / 1,174 tests.
- Full Node/CLI/web typecheck, native and type-aware audits, full and changed-code lint,
  formatting, max-lines, diff, and reliability-manifest validation pass.
- Electron 43.1.0, Playwright 1.59.1, native runtime, CLI artifact, E2E desktop bundle,
  paired web bundle, and an isolated headless `orca serve` plus paired-web-client journey pass
  after rebuilding the exact diff.
- Three real Electron navigation journeys pass. The `beforeunload` journey disproved a
  review concern: prevented `loadURL` emitted `will-prevent-unload` then `did-fail-load`, with no
  `will-navigate`, `did-start-navigation`, provisional failure, frame commit, or graph-epoch
  change; the renderer canary remained alive, so no retirement fence opened and no synthetic
  listener was retained.
- Two fresh read-only reviews found no actionable lifecycle, correctness, security, resource, or
  mixed-version defect. They retained live-Electron frame-wrapper stability and fail-closed stuck
  navigation as explicit activation caveats.

Final bridge-stage rerun on 2026-08-14:

- `pnpm exec oxfmt --write <14 intended files>`: passed.
- `pnpm exec vitest run --config config/vitest.config.ts <8 reliability-gate files>`: 8 files,
  174 tests passed in 0.9 seconds.
- `pnpm run typecheck`: Node, CLI, and web typechecks passed.
- `pnpm run lint`: full lint, native/type-aware audits, 84 reliability gates, max-lines ratchet,
  bundled-skill checks, and localization checks passed.
- `pnpm run check:code-quality:changed`: zero findings across 134 stacked changed files.
- `git diff --check`: passed.

Post-rebase rerun on 2026-08-14:

- Recreated the verified 24-branch local stack and rebased its 25 commits onto
  `origin/main@ff9bc0f079bb`. One paired-tunnel conflict preserved both upstream worktree-visibility
  defaults and optional browser-tunnel capability advertisement.
- The conflict oracle passed 2 files / 21 tests. The browser/window suite passed 88 files / 1,168
  tests with one intentional skip.
- `pnpm run typecheck`, `pnpm run lint`, and `pnpm run check:code-quality:changed` passed; the
  updated main includes 85 reliability gates and changed-code quality reported zero findings.
- Rebuilt Electron E2E and CLI artifacts; all three renderer-navigation journeys passed in real
  Electron 43.1.0.
- Rebuilt the paired web bundle; an isolated headless `orca serve` plus separate paired Electron
  web client passed its host-owned ACK-starvation and recovery journey.

Final pre-publish rebase on 2026-08-14:

- Fetched `origin/main@9bb8836bb6`, cascade-rebased all 25 stack branches without conflict, and
  retained a local safety pointer at `sta-4150-stack-pre-origin-9bb-20260814`.
- `git range-diff` marked all 26 patches identical before this ledger-only amend.
- The current stage then passed 12 files / 199 tests, full node/CLI/web typecheck and lint, the
  Electron build, paired-web projection, formatting, changed-code quality, and diff checks.
- A fresh open-PR scan found only the 24 existing Jinwoo-owned STA-4150 draft layers and no newer
  competing implementation.

Before publishing this stage:

- [x] Run the final full typecheck, native/type-aware audits, max-lines ratchet, formatting, and
      diff checks against the completed stage diff.
- [x] Perform fresh correctness, lifecycle, security, and resource review.
- [x] Commit the renderer-bridge stage.
- [x] Sync the draft stack onto the latest `origin/main` while preserving every PR base.
- [x] Push and open a draft PR stacked on #14566.
- [ ] Monitor required CI and fix any actionable failure.
- [x] Attach the PR and post one concise Linear checkpoint while keeping STA-4150 In Progress.
- [x] Update the Orca worktree comment with the published checkpoint.

## Published stage: retained renderer registry (#14596)

The preceding stage lacked a preload request consumer and renderer-owned retained page surface.
This production-inert stage adds:

- A top-frame-only preload listener installed before the renderer subscriber, with a bounded
  512-request queue, fixed timeout, immediate overflow failure, latest-subscriber fencing, and
  outcomes bound to the exact admitted request identity and operation.
- A non-React document-level retained host keyed by exact partition, page ID, and page generation.
  It creates only `about:blank`, omits `allowpopups`, shares concurrent exact mounts, never
  reparents a live webview, and bounds 256 total plus 64 per partition.
- Exact attachment, delayed `getWebContentsId`, DOM-ready fallback, retirement, guest destruction,
  renderer-process loss, and denied-attachment settlement with a renderer memory profile.
- A paired-web guard, so browser clients without Electron remain unchanged.

Current evidence:

- Baseline: both new modules were absent and the two initial suites failed to import.
- Deterministic plus real Electron gate: 12 files / 199 tests pass locally.
- The first Electron candidate failed because `getWebContentsId()` was transiently unavailable at
  `did-attach`; DOM-ready retry fixed it. The second failed because a denied pre-attach
  `destroyed` event released state without rejecting the mount; exact destruction settlement fixed
  it.
- A later deterministic sequence proved early `did-attach` cancelled the deadline before a guest
  ID existed and retirement released that observed guest without destruction; the registry now
  keeps the deadline through valid identity and holds observed attachment until `destroyed`.
- Fresh review caught cached guest-ID re-advertisement after the guest became unreadable; an exact
  live-ID comparison now fences that incarnation until destruction instead.
- A throwing renderer reply transport previously produced an unhandled rejection after local
  settlement; reply construction and send failure are now contained while main retains its timeout.
- Electron 43.1.0 now proves a positive guest ID matching `did-attach-webview`, actual main-frame
  reply admission, a connected offscreen retained host, exact destruction on retirement, and
  immediate fail-closed cleanup for an unprepared partition.
- Full node/CLI/web typecheck, lint and native/type-aware audits, the 85-gate reliability manifest,
  changed-code quality, max-lines, formatting, diff checks, and rebuilt desktop/web artifacts pass.
- The broad browser/window/preload/renderer suite passed 137 files / 1,533 tests with one
  intentional skip before the final focused lifecycle hardening; the exact changed path then
  passed the 12-file / 199-test gate.
- Three fresh read-only reviews found no security blocker. Their lifecycle/resource findings
  reproduced and fixed premature deadline cancellation, observed-guest release, stale cached-ID
  advertisement, and unhandled reply-transport rejection. Remaining notes are fail-closed
  activation caveats: missing-destruction capacity retention, conservative transient-ID fencing,
  and live Electron/cross-platform soak.

## Published stage: environment-scoped client-host composition (#14613)

Branch `sta-4150-browser-client-host-composition` is stacked on #14596 as draft PR
[#14613](https://github.com/stablyai/orca/pull/14613). The candidate is production-inert: it
advertises no browser-host capability, publishes no client placement, and has no normal
browser-creation caller.

Implemented in this stage:

- One environment pairing revision owns at most one composed `PairedRuntimeBrowserClientHost`,
  command executor, current renderer selector, route Session/WebContents registries, and
  reference-counted route per canonical execution-host key.
- Authority connection identity includes Orca profile, environment, pairing revision, fresh
  authority runtime, pairing public key, and paired-device identity. Native route keys must name
  that exact authority runtime; SSH routes retain the runtime-minted lease-bound grant contract.
- Environment invalidation and app quit close the authenticated control transport before page
  cleanup, then force-close every route. No fallback to desktop DNS, sockets, or server placement
  is allowed.
- A non-cooperative handler removes network reach immediately, defers executor cleanup until the
  exact late settlement, and keeps a bounded environment tombstone until cleanup proves complete.
- Failed or cancelled creates that are cleanly absent can retire and be forgotten. Ambiguous
  cleanup remains generation-fenced until process restart or future authenticated reconciliation,
  and close racing an in-flight create cannot retain a late page.

Deterministic evidence:

- Baseline: the route registry, composition, and registry suites failed to import because their
  modules did not exist.
- The first CI run exposed an import-time Electron side effect in an unrelated ephemeral-VM test:
  importing runtime-environment cleanup constructed the renderer bridge and called `ipcMain.on`.
  The exact shard now proves renderer IPC is bound lazily on first renderer use instead.
- Focused composition gate: 9 files / 118 tests passed.
- Focused composition plus execution-route gate: 22 files / 271 tests passed.
- WebContents/renderer gate: 12 files / 201 tests passed, including isolated Electron 43.1.0.
- Real old/new terminal wire compatibility: 5/5 journeys passed.
- Full Node/CLI/web typecheck, lint and native/type-aware audits, 85-gate reliability manifest,
  max-lines ratchet, formatting, changed-code quality, and diff checks passed.
- CLI, production Electron, and paired-web artifacts rebuilt from the exact diff. Electron is
  43.1.0, Playwright is 1.59.1, Node is 24.18.0, and pnpm is 10.24.0.
- Fresh lifecycle, correctness, security, and resource re-reviews found no blocker. Review-driven
  fixes preserve the asynchronous starter contract, test permanent fail-closed tombstones, and
  report deferred cleanup failures without releasing the safety fence.
- The CI regression fix passes the exact formerly failing test plus renderer, paired-host, and
  runtime-environment suites: 4 files / 59 tests, full typecheck, lint/audits, changed-code quality,
  formatting, and diff checks.

## Published stage: authenticated page reconciliation semantics (#14617)

Branch `sta-4150-browser-client-page-reconciliation` is stacked on #14613 as draft PR
[#14617](https://github.com/stablyai/orca/pull/14617). The stage adds no exchanged field,
capability, or production caller.

Current evidence:

- Baseline: the focused suite failed because the reconciliation planner did not exist.
- The planner compares bounded runtime intent with bounded client inventory and emits immutable
  exact-retain, explicit old-epoch reclaim, orphan-close, missing-restore, and
  close-before-restore actions.
- Profile, execution-host, authority, generation, and outcome-unknown mismatches are never
  adopted. Old-epoch reclaim requires the exact persisted previous authority, a real epoch
  transition, and the same browser-host client identity; numeric counters may restart under the
  new epoch.
- Duplicate or over-capacity inventories fail atomically rather than returning a partial plan.
- Focused state-machine gate: 1 file / 28 tests passed.
- The placement/lease package passed 5 files / 58 tests; full node/CLI/web typecheck, lint/audits,
  85-gate manifest, changed-code quality, formatting, and diff checks passed.
- After rebasing the full stack onto `origin/main@500b72d8ef`, the combined composition,
  reconciliation, and exact CI-regression gate passed 13 files / 152 tests. Cross-version wire
  passed 5/5; full typecheck, lint/audits, the updated 86-gate manifest, changed-code quality, and
  diff checks passed.
- Two fresh read-only reviews found no remaining authority, ordering, boundedness, immutability,
  portability, or mixed-version blocker. Review caught and fixed same-epoch reclaim, while a
  separate test preserves valid counter restart under a new epoch.
- This stage pins semantics only. Authenticated inventory transport, runtime integration,
  executor inventory, pending-close resolution, and real reconnect/restart journeys remain.

## Published stage: authenticated hosted-page inventory (#14648)

Branch `sta-4150-browser-client-page-inventory` is stacked on #14617 as draft PR
[#14648](https://github.com/stablyai/orca/pull/14648). It carries one optional, complete page
snapshot on the existing authenticated browser-host attach. It does not execute the reconciliation
plan, advertise a runtime capability, activate client placement, or change current browser
behavior.

Implemented:

- Independent `pageInventoryProtocolVersion: 1` negotiation on attach, ready, and exact lease
  authority. Missing server echo remains unsupported/unknown; an unsolicited echo fails closed.
- A frozen inventory record with exact runtime, epoch, client, host/page generations, browser
  profile, execution-host key, `active` or `outcomeUnknown` state, and optional normalized URL.
- Atomic limits of 256 unique page IDs, 384 JSON-encoded bytes per inventory-only identity, and 768
  KiB total, below the remote subscription's 1 MiB retained parameter ceiling and the 8 MiB
  encrypted WebSocket frame ceiling. Existing wire identities keep their old 256-character bound.
  Optional URLs are omitted in deterministic codepoint order when needed; page identity is never
  truncated or dropped. If a legacy-valid identity cannot fit the optional inventory encoding, the
  client keeps executing page commands and declines inventory negotiation for that attach.
- Attach-level and runtime-registry rejection for incomplete negotiation, duplicate pages, foreign
  client authority, invalid records, and oversized snapshots. A previous runtime authority remains
  available for exact persisted-authority restart reconciliation, which additionally requires the
  inventory lease's authenticated paired-device identity to match persisted provenance. Old attach
  and ready decoders strip the optional fields.
- Executor snapshots classify in-flight creation, retirement, ambiguous cleanup, stale renderer,
  and destroyed guest authority as `outcomeUnknown`; an exact current retained guest is `active`.
  Create-to-active transitions cannot emit a duplicate page ID, successful normalized navigation
  updates the frozen URL snapshot, and percent-expanded URLs that exceed the field bound are omitted.
- Composition samples the executor exactly once before attach, and the runtime stores a separate
  immutable snapshot on the exact authenticated lease.

Deterministic evidence:

- Baseline: 5 files failed 7 expected assertions because the inventory contracts and accessors did
  not exist.
- Focused inventory/reconciliation gate: 11 files / 145 tests passed.
- Broader authenticated lease/tunnel gate: 16 files / 188 tests passed.
- Real old/new terminal wire compatibility: 5/5 journeys passed.
- Full node/CLI/web typecheck, lint and native/type-aware audits, the 86-gate reliability manifest,
  changed-code quality, max-lines ratchet, formatting, diff checks, CLI build, Electron build, and
  paired-web projection passed on `origin/main@a3b472d050`.
- Two fresh read-only reviews found no P0/P1 or must-fix item. Their notes preserve intentional
  restart acceptance, bounded ambiguous-cleanup tombstones, atomic inventory opt-out, and the
  one-shot snapshot as an activation blocker rather than weakening those fences.

Architectural limitation at #14648: the executor belonged to one lease composition, so transport
loss closed its pages. The local reconnect-grace stage below preserves that lifetime, but does not
yet execute the stored inventory plus runtime intent through the pinned reconciliation planner.
Treating a missing or unavailable snapshot as empty remains forbidden.

## Published stage: negotiated same-client reconnect grace (#14691)

This stage adds optional `leaseReconnectProtocolVersion: 1` negotiation only beside the complete
page-inventory protocol. It remains production-inert: browser-host capabilities are still not
advertised, normal browser creation does not select client placement, and server/offscreen
placement is unchanged.

Implemented:

- A disconnected negotiated lease becomes unavailable without destroying its exact authority,
  placements, execution-host grants, command ledger, dispatcher, executor guests, or local SOCKS
  listener. Every tunnel transport is fenced immediately, new route admission is blocked, and the
  preserved listener rejects CONNECT without desktop DNS or socket fallback.
- Only the same browser-host client, paired device, protocol set, and ordered capability set may
  restore the existing authority during the 15-second grace. Foreign identity, authority or
  capability mismatch, explicit revocation, missing legacy echo, and grace expiry remain terminal.
- The server emits `ready` before reattaching command delivery and replaying unsettled commands.
  The preserved client dispatcher returns its cached immutable result for duplicate completed
  mutations, and a partial replay transport failure detaches delivery without discarding the
  bounded ledger so the next reconnect can retry safely.
- Client retries use deterministic client-specific jittered exponential delay capped at two
  seconds and by the remaining grace. Duplicate/stale callbacks and repeated loss cannot retain a
  superseded subscription or timer.

Deterministic evidence:

- Baseline: the initial reconnect oracle failed 2/2 because negotiation was not consumed and no
  reconnect path existed. A repeated-loss oracle later exposed a real promise-finalization race;
  the final implementation fences stale callbacks and admits the next exact loss.
- Focused reconnect/control gate: 14 files / 150 tests passed in 2.23 seconds.
- Broader control, SOCKS/tunnel, SSH-adapter, composition, and runtime gate: 32 files / 401 tests
  passed. Real old/new terminal wire compatibility passed 5/5.
- Latest-main rerun: 14 files / 150 focused tests, 32 files / 347 broader tests, and 5/5
  cross-version journeys passed. Full node/CLI/web typecheck and the 87-gate lint suite passed.
- A final review reproduced a reconnect-only result-admission overflow: two running commands could
  consume the complete bounded settlement budget, then the first replay of those exact commands
  double-charged capacity and permanently closed the preserved lease. The deterministic oracle was
  red with two expected replay deliveries but only the original two handler calls before terminal
  failure. Active admissions now dedupe only the exact page ID, page generation, command sequence,
  and command ID tuple; replay still validates through the dispatcher but submits each result once.
- The completed candidate passes 14 files / 151 focused tests and 16 files / 167 reconnect plus
  sandboxed-preload contract tests. The full Node/CLI/web typecheck, repository lint and native and
  type-aware audits, 87-gate manifest, max-lines ratchet, localization checks, changed-code quality
  across 179 files, five-file formatting check, and `git diff --check` pass.
- The isolated paired-Electron journey exposed a parent-stack preload crash: the renderer-registry
  validator left `zod` external to Electron's sandboxed preload. Latest main passed and both the
  inventory parent and reconnect candidate failed before pairing. Bundling `zod` in the preload
  made the same journey pass and adds a build-config contract test at the introducing layer. The
  journey requires `electron-vite build --mode e2e`; reusing a normal build with `SKIP_BUILD=1`
  correctly failed at the absent E2E-only `window.__store`, while the rebuilt unchanged journey
  passed 1/1 in 11.2 seconds.
- Fresh reviews found no P0/P1 for this production-inert stage. Before activation they require:
  per-stream late-frame teardown that cannot collapse every tunnel, fair/recoverable browser-host
  long-poll admission across devices, placement retirement when a lease is fenced, and a main-owned
  navigation grant that a compromised renderer cannot bypass with direct webview navigation.
  A proposed additional result-expiry P1 was disproved: settled records remain replayable until
  bounded eviction, and the default client cache (64/page, 1,024 global) dominates the server's
  maximum outstanding set (32/page, 256 global). Preserve that limit relationship.
- Live headed/headless/browserless reconnect, Electron containment, SSH/WSL, and physical
  cross-platform proof remain activation blockers; this deterministic stage makes no such claim.

## Published stage: retired tunnel-frame isolation (#14694)

The browser-tunnel protocol already allocates stream IDs monotonically and never reuses an ID
within one tunnel generation. The client retains its next allocated ID, and the execution-host
session retains a bounded set of every reserved ID. That is enough to distinguish an in-flight
frame for a retired or permanently burned stream identity from a frame for a never-reserved
identity without a new field or opcode.

Implemented:

- Both tunnel ends ignore a valid non-Open frame only when its current generation proves that exact
  stream ID previously existed and is now retired.
- A never-allocated client ID, never-reserved execution-host ID, malformed frame, stale generation,
  or explicit Open reuse keeps the existing fail-closed behavior. Rejected execution-host opens
  burn their reserved ID before admission and may therefore ignore later frames without targeting
  another stream.
- Ping/Pong handling moved into one concrete heartbeat module so the session remains within its
  300-line module budget without a suppression or limit bump.

Deterministic evidence:

- Baseline was 2/2 red: retire stream 1, keep stream 2 active, deliver late Data for stream 1, and
  observe both client and execution-host session destroy stream 2.
- The same oracle is green on the candidate: stream 2 carries a marker after the late frame, while
  a never-allocated ID still closes the route and a reused Open still fails closed.
- Focused client/session: 2 files / 28 tests passed. Full browser-network/control gate: 16 files /
  198 tests passed. Full Node/CLI/web typecheck, lint and native/type-aware audits, the 87-gate
  manifest, max-lines ratchet, localization checks, formatting, diff checks, and changed-code
  quality across 180 files pass.
- A fresh read-only review found no P0/P1 or required fix across all opcodes, generation rollover,
  mixed versions, resource bounds, and malicious-peer behavior. It prompted the precise
  reserved-versus-never-reserved wording above.
- No payload, opcode, capability, field, limit, or publication changes. New/new peers avoid the
  teardown race; an older peer may retain its conservative whole-tunnel close until upgraded.

## Published stage: admission fairness and recovery (#14747)

The original global browser-host cap allowed one authenticated paired device's four host leases
to consume every host slot. A second paired desktop received `runtime_busy`, and both initial
attach and reconnect treated that explicit capacity response as terminal.

Deterministic baseline:

- Four hosts from device A filled the old global host budget, so device B could not attach.
- Raising only that budget let asks plus hosts consume every long-poll slot and starve ordinary
  waits.
- One initial `runtime_busy` ended startup instead of recovering when capacity returned.
- One reconnect `runtime_busy` ended preserved authority instead of staying inside its negotiated
  grace.

Implemented:

- Browser hosts use at most 8 of 16 long-poll slots and at most 4 per authenticated paired device.
- Asks plus hosts use at most 12 slots, preserving 4 for ordinary waits.
- Initial and negotiated reconnect `runtime_busy` responses retry with deterministic,
  client-specific jitter inside the existing attach timeout or reconnect grace.
- Exact socket close, explicit lease close, and timeout release global, class, device, timer, and
  subscription ownership independently.

Compatibility and scope:

- No exchanged field, opcode, capability, payload, placement, publication, or server-hosted
  browser behavior changes.
- New clients recover against old servers; old clients keep terminal retry behavior but benefit
  from fairer new-server admission; new/new peers recover automatically.
- `runtime_busy` remains browser-host-local and was not added to shared recoverable errors.
- SSH, WSL, headed/headless/browserless hosts, folder workspaces, worktrees, and browser placement
  are untouched.
- The global capacity guarantees two saturated four-host devices, not arbitrary fairness for every
  later device; later devices retry until a slot returns.

Validation and review:

- Focused causal gate: 2 files / 16 tests passed in 7.89 seconds on `origin/main@5b7f44278a`.
- Broader attach/reconnect/authority package: 15 files / 159 tests passed in 7.18 seconds on the
  same base.
- Full Node/CLI/web typecheck, root lint, native audit, 87-gate reliability manifest, max-lines
  ratchet, localization, formatting, diff checks, and STA-4150 changed-code quality pass. The full
  type-aware audit is blocked only by current main's unrelated
  `config/scripts/pr-test-loc-summary.test.mjs:88` warning; this branch does not modify that file.
- One OpenCode review found wait starvation in the first capacity split and reconnect
  `runtime_busy` as a resilience gap. The shared ceiling and reconnect retry tests resolved both;
  no blocking correctness, cleanup, race, or wire-compatibility finding remained, and the tab was
  closed.

## Acceptance matrix

| Requirement                                             | State       | Evidence or remaining gap                                                         |
| ------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| Negotiated contracts, placement, leases and generations | Implemented | Optional/capability-gated wire matrix and deterministic authority tests are green |
| Fail-closed tunnel and native/SSH/WSL execution routes  | Implemented | Bounded route, remote-DNS, reconnect, Docker/OpenSSH, and WSL gates are green     |
| Electron partition, retained guest and local UI/input   | Implemented | Lifecycle tests, Electron/CDP proof, and headed paired product journey are green  |
| Agent/CLI routing and reconciliation                    | Implemented | Bounded automation, lost-ack, replacement, reconnect, and restart gates are green |
| No client-placement screencast or duplicate server page | Proven      | Headed and headless paired E2E assert zero host guest and no screencast           |
| Old/mobile/web/ineligible and explicit-server behavior  | Preserved   | Omitted placement stays server-hosted; compatibility and fallback tests are green |
| Cross-platform and packaged rolling releases            | Partial     | Released-schema skew is green; native Windows CI and physical/package gaps remain |

## Remaining implementation order

1. Finish replacement-stack CI and fix only reproducible, actionable failures.
2. Obtain reviewer sign-off for the five landing layers.
3. Before release, run the four explicit physical/packaged journeys above or accept their risk.

## Compatibility costs and risks

- Client-local browser storage changes cross-device cookie/cache behavior; placement must be
  visible and explicit.
- The browser fingerprint is hybrid: desktop Chromium features with execution-host IP/DNS.
- Fail-closed cleanup can strand bounded slots and route resources until reconciliation; releasing
  without proof risks desktop-network leakage or targeting a replacement guest.
- Electron partitions are session-wide. A profile/execution-host change requires a new engine and
  partition, never proxy retargeting.
- Service workers, speculative connections, QUIC/HTTP3, DoH, WebTransport, network-service
  restarts, downloads, and other non-WebRTC direct-egress paths remain unproven. WebRTC direct UDP
  is denied on the exact routed guest, with real Electron packet-capture evidence.
- Renderer crash or last hosting-window close suspends/closes client page generations; no server
  fallback is allowed.
- The open draft stack is intentionally large. Review/landing order and rebasing are delivery
  risks even when each stage is narrow.

## Validation ledger

Latest reviewed stage (#14566):

- Focused reliability: 5 files / 152 tests.
- Browser plus paired-route package: 61 files / 837 tests.
- Full Vitest: 4,900 files / 52,536 tests, 121 intentional skips.
- Full node/CLI/web typecheck, native and type-aware zero-warning audits, changed-code quality,
  reliability manifest, max-lines ratchet, formatting, diff checks, CLI build/artifact, and package
  checks passed.
- Cross-version terminal wire: 5/5.
- Electron 43.1.0 and Playwright 1.59.1 were verified.
- The repository-required `$electron` skill is not installed or exposed in this workspace. The
  Playwright CDP harness still proves an isolated headless `orca serve` plus paired web client
  after rebuilding the E2E Electron, CLI, and paired web artifacts. The stage has no renderer
  consumer or production caller, so there is no client-hosted page or network-containment UI
  claim to render yet; rendered proof remains mandatory once that surface exists.

Current local renderer-registry stage:

- Focused reliability: 12 files / 199 tests, including one isolated real-Electron lifecycle.
- Broad regression: 137 files / 1,533 tests passed with one intentional skip before the final
  focused lifecycle hardening.
- Full node/CLI/web typecheck, lint/audits, the 85-gate reliability manifest, changed-code quality,
  max-lines, formatting, diff checks, Electron build, and paired-web projection pass.
- Electron 43.1.0 proves exact main-frame IPC settlement, blank retained guest attachment, delayed
  guest-ID readiness, denial cleanup, and destruction without reparenting.
- On the latest-main rebase, the isolated paired-Electron startup was red because the sandboxed
  preload could not resolve external `zod`; the same test is green after bundling that validator,
  and the output contract pins the preload dependency policy.
- No capability, remote field, placement publication, production executor caller, BrowserPane
  adoption, navigation target, server/offscreen behavior, or paired-web behavior is activated.

Published reconnect-grace stage (#14691):

- Focused reliability: 14 files / 151 tests, including partial replay failure, repeated loss,
  stale callbacks, mixed-version echo behavior, stable SOCKS fencing, and bounded jittered retry.
- Reconnect plus preload contract: 16 files / 167 tests after the exact replay-admission fix.
- Broader affected package: prior 32 files / 401 tests and latest-main 32 files / 347 tests;
  cross-version terminal wire passed 5/5.
- Full node/CLI/web typecheck, lint/audits, 87-gate manifest, max-lines, formatting, localization,
  relay/CLI/Electron/paired-web builds, and isolated paired-Electron startup/link routing pass on
  `origin/main@e570cade3c`; the final four-file fix rerun also passed full typecheck, lint/audits,
  changed-code quality, formatting, and diff checks.
- No mobile-facing persisted state, route, deep link, framing opcode, minimum version, or pairing
  durability contract changes. The optional JSON field is stripped by old peers and required only
  after exact echo on a reconnect attempt.

Published retired-frame isolation stage (#14694):

- Baseline/candidate oracle: 2 failed / 26 passed before the fix, 28/28 passed after it.
- Full affected browser-network/control gate: 16 files / 198 tests passed.
- Full Node/CLI/web typecheck, root lint, native audit, 87-gate manifest, max-lines, localization,
  formatting, diff checks, and changed-code quality pass. Full type-aware audit is clean for the
  changed stack and otherwise has the single upstream #14738 warning at
  `config/scripts/pr-test-loc-summary.test.mjs:88`.
- The full 31-patch stack rebased conflict-free onto `origin/main@3908978ba4`; `git range-diff`
  marked every patch identical before this ledger amend.

Published admission-fairness stage (#14747):

- Baseline: device A exhausted the old global host cap; device B, initial retry, and reconnect
  recovery failed. A naïve larger host share then starved ordinary waits.
- Candidate: focused 2 files / 16 tests and broader 15 files / 159 tests passed.
- Full Node/CLI/web typecheck, lint/audits, 87-gate manifest, max-lines, localization, formatting,
  diff checks, and changed-code quality pass.
- No live Electron claim is added; this stage changes admission and recovery contracts below the
  renderer and needs no rendered UI proof.
- The 32-patch stack rebased cleanly onto `origin/main@5b7f44278a`; range-diff marks every patch
  identical.

Published lease-fence placement-retirement stage (#14753):

- Baseline: 6 of 7 new public-registry assertions failed because terminal host release,
  replacement, legacy disconnect, and reconnect-grace expiry left exact client placements
  cancellable. The negotiated reconnect-grace preservation control passed.
- Candidate: current-token terminal lease fencing marks only the exact client ID and host
  generation retirement-pending before the lease fence settles. Existing retirement becomes
  non-cancellable; server placements, other hosts, and replacements remain untouched.
- Capacity remains occupied until exact retirement completion. The runtime does not infer guest
  destruction or delete placement from transport loss alone.
- Focused placement/lifecycle coverage passes 5 files / 44 tests; the broader affected
  attach/reconnect/route/command surface passes 16 files / 166 tests; Node/CLI/web typecheck,
  changed-code quality, the 87-gate manifest, max-lines, localization, formatting, diff checks,
  and 5/5 cross-version terminal-wire journeys pass.
- Full lint reaches only the known upstream-main type-aware warning at
  `config/scripts/pr-test-loc-summary.test.mjs:88`; the changed stack remains clean.
- No exchanged field, opcode, capability, payload, publication, placement default, SSH/WSL path,
  folder/worktree behavior, Electron UI, or server-hosted browser behavior changes.

Published terminal navigation-authority stage (#14754):

- Baseline: the new composition oracle failed 1 of 11 assertions because terminal host loss began
  asynchronous control cleanup without first suspending routes or revoking local WebContents
  navigation authority.
- Candidate: terminal close marks the composition closed, suspends every retained route, then
  revokes only exact opaque guest lifecycle claims before host cleanup can wait for command
  handlers. Negotiated reconnect still suspends routes without destroying pages or grants.
- Late in-flight create work rechecks the fence after every asynchronous admission boundary and
  cannot register or grant a page after terminal authority loss.
- Revocation neither destroys a guest nor releases its Session or route. If revocation throws,
  executor close remains fenced, reports the failure, and still attempts exact guest, renderer,
  Session, and route cleanup.
- Focused coverage passes 3 files / 62 tests; the WebContents lifecycle gate passes 12 files / 132
  tests; the paired-runtime gate passes 16 files / 167 tests; mixed-version terminal wire passes
  5/5.
- Node/CLI/web typecheck, changed-code quality, 87-gate reliability validation, max-lines ratchet,
  localization, formatting, and diff checks pass. Full lint reaches only the known upstream-main
  type-aware warning at `config/scripts/pr-test-loc-summary.test.mjs:88`.
- No exchanged field, opcode, capability, payload, publication, placement default, SSH/WSL path,
  folder/worktree behavior, UI, or server-hosted browser behavior changes. The stage remains
  production-inert and needs live activation/topology evidence later.

Published reconciliation-execution stage (#14756):

- Baseline: the deterministic executor oracle failed because no module executed the immutable
  reconciliation plan; the planner could describe retain/reclaim/close/restore work but had no
  proof barrier, timeout, cancellation, or bounded scheduler.
- Candidate: reclaim and close actions run with configurable concurrency capped at 16 and an
  action deadline capped at 60 seconds. Every independent phase-one action is attempted, while any
  rejection, timeout, or abort blocks all restores and requires a fresh authenticated plan.
- Close-then-restore pages cannot restore until their exact close and every other phase-one action
  settle positively. Action callbacks receive an abort signal, late rejections remain handled, and
  no mutation is retried automatically.
- Focused planner/executor coverage passes 2 files / 45 tests. The affected placement, lease,
  reconnect, command, route, and RPC package passes 18 files / 212 tests; mixed-version terminal
  wire passes 5/5; the 87-gate reliability manifest includes the executor.
- Node/CLI/web typecheck, changed-code quality, max-lines, localization, skill-manifest, formatting,
  and diff checks pass. Full lint reaches only the known upstream-main type-aware warning at
  `config/scripts/pr-test-loc-summary.test.mjs:88`; the native audit and all later subchecks pass.
- Fresh lifecycle, resource, security, mobile-compatibility, and cross-platform review found no
  actionable issue. Work is bounded to at most 256 planner actions and 16 active callbacks, timers
  and parent-abort listeners are cleaned on success/failure/timeout, and no path, shell, dependency,
  network, persisted-state, exchanged-field, capability, publication, UI, or placement behavior is
  changed. Concrete adapters must fence late mutation by exact authority generation before use.
- Draft PR [#14756](https://github.com/stablyai/orca/pull/14756) stacks on #14754 and remains draft.
  GitHub auto-attached it to STA-4150; the ticket remains In Progress.

Published reconciliation-command-contract stage (#14759):

- Baseline: the shared command-schema oracle failed 3 of 5 assertions because reclaim, close, and
  restore variants plus their negotiation did not exist. Client attach failed to retain the
  optional version, and the authenticated server neither retained nor echoed it.
- Candidate: a separate optional `pageReconciliationProtocolVersion: 1` is valid only beside page
  commands and complete page inventory. The server retains and echoes it only after an explicit
  authenticated request; the client enables it only after an exact ready echo and rejects
  unsolicited, dependency-inconsistent, or in-place reconnect changes.
- Reclaim and close payloads bind an exact prior authority; restore carries bounded profile,
  execution-host, and optional URL inputs. Legacy create/navigate payloads are unchanged. Central
  server admission rejects every reconciliation variant before delivery to a legacy v1 command
  lease, and command-result settlement requires the exact negotiated reconciliation authority.
- Old attach and ready decoders strip the optional field. An old server can omit the echo and the
  new client safely disables reconciliation. The current production `PairedRuntimeBrowserClientHost`
  composition deliberately does not advertise the new subprotocol, so no new command, placement,
  publication, or page mutation is active yet.
- Focused protocol/client/server coverage passes 6 files / 58 tests; the broader host lease,
  reconnect, command, reconciliation, and RPC surface passes 21 files / 219 tests; mixed-version
  terminal wire passes 5/5. On `origin/main@931cb037c5`, Node/CLI/web typecheck, full lint and
  audits, changed-code quality, the 87-gate reliability manifest, max-lines, skill manifests,
  localization, formatting, and diff checks pass.
- All 36 stack patches rebased conflict-free from `origin/main@5b7f44278a` to
  `origin/main@931cb037c5`; `git range-diff` marks every patch identical. The only intervening main
  change fixes the previously known unrelated type-aware warning and overlaps no STA-4150 file.
- Fresh security/resource/mobile/cross-platform review found no actionable issue. The stage adds no
  dependency, network sink, path/shell behavior, timer, retry loop, cache, persisted state, mobile
  route/framing, UI, SSH/WSL branch, or server/offscreen behavior. Concrete reclaim/close/restore
  adapters and their exact page-authority rekeying remain the next stage.
- Draft PR [#14759](https://github.com/stablyai/orca/pull/14759) stacks on #14756 and remains draft.
  GitHub auto-attached it to STA-4150; the ticket remains In Progress.

Published reconciliation-adapter stage (#14763):

- Baseline: the client had negotiated command shapes but no concrete reclaim, restore, or close
  adapter. The focused adapter suites failed because their modules and exact rekey operations did
  not exist.
- Candidate: reclaim rekeys the same guest across renderer retention, prepared Session authority,
  WebContents lifecycle claims, and navigation authority without remounting. Restore creates a new
  blank guest and applies optional initial navigation only after exact authority admission. Close
  retires only an exact prior authority.
- Revert oracles prove three review fixes: uncertain renderer rekey must retire both the old and new
  exact renderer identities; failed cleanup must leave immutable `outcomeUnknown` inventory without
  a retryable live-page handle; and a failed close must release its terminal command fence.
- A fresh new-authority dispatcher successfully reclaims an old-authority executor page. A proposed
  same-dispatcher create-to-reclaim test was rejected because reclaim is required to cross authority
  epochs, while a dispatcher is bound to one immutable lease authority.
- Focused changed surface: 19 files / 233 tests. Paired runtime/server: 13 files / 179 tests.
  Isolated Electron lifecycle: 1/1. Cross-version terminal wire: 5/5. Node/CLI/web typecheck, full
  lint and native/type-aware audits, 87 reliability gates, max-lines, skill/localization checks,
  formatting, diff checks, and changed-code quality pass with zero findings.
- One Electron invocation run concurrently with typecheck and the wire journey observed Chromium's
  transient empty initial URL; the required standalone rerun passed 1/1. Keep this real-Electron
  file isolated from broad parallel suites.
- Fresh security, lifecycle, and portability reviews found and drove the cleanup fixes above. The
  remaining activation blocker is architectural: a terminal authority change currently tears down
  the composition/executor that owns the retained page. Server reconciliation must preserve that
  client state, issue actions through a dedicated authenticated path, and rekey placement only after
  client proof.
- Production advertisement remains disabled. Old clients, server/offscreen placement, browserless
  hosts, SSH/WSL routes, folder workspaces, git worktrees, and existing browser behavior are
  unchanged by this stage.
- Draft PR [#14763](https://github.com/stablyai/orca/pull/14763) stacks on #14759 and remains
  draft. GitHub auto-attached it to STA-4150; the ticket remains In Progress.

Published proof-driven reconciliation-orchestration stage (#14769):

- Baseline: all 5 initial orchestration assertions failed because the registry had no
  `reconcileClientPages` entry point.
- Candidate: one immutable authenticated inventory is consumed once. Reclaim, close, and restore
  issue through the exact negotiated command ledger; target generations reserve capacity without
  publishing placement, and placement commits only after the exact completed client result.
- Unknown results stay replayable. An inventory captured while a reconciliation result is unknown
  is quarantined; result replay must settle first, followed by another fresh attach and inventory.
- A reconnect-grace review oracle was red because the old attempt remained pending after connection
  authority changed. The candidate now aborts that attempt immediately while preserving the exact
  unknown command for replay; the focused test is green.
- A close-capacity review oracle was red because a completed close retained an active ledger page
  slot forever. The ledger now releases that slot after exact close proof while retaining bounded
  exact result replay; the `maxPages: 1` regression is green.
- Missing-page reservations claim placement capacity; replacement reservations do not double-count
  an existing slot. A competing ordinary placement cannot steal reserved capacity.
- Validation on the pre-rebase parent: focused 5 files / 55 tests, affected 17 files / 172 tests,
  paired-runtime 18 files / 183 tests, real paired RPC/E2EE integration 3/3, mixed-version terminal
  wire 5/5, and isolated Electron lifecycle 1/1. Full Node/CLI/web typecheck, lint and
  native/type-aware audits, 87 reliability gates, max-lines, localization/skill checks, changed-code
  quality, formatting, and diff checks pass.
- The full 38-patch stack rebased conflict-free from `origin/main@c4e397bcdc` to
  `origin/main@92fb276040`; range-diff marked every patch identical before this tracker amend, and
  all 36 local published-stage branch refs were advanced to their corresponding commits.
- Post-rebase focused coverage passes 5 files / 55 tests; full Node/CLI/web typecheck, lint/audits,
  87-gate validation, max-lines, changed-code quality, real paired RPC/E2EE integration 3/3, isolated
  Electron 1/1, formatting, and diff checks pass.
- Readiness review found no P0/P1. There is no mobile persisted state, handshake/framing, route,
  deep-link, path/shell, native-module, dependency, UI, or production capability change. Work is
  bounded by 256 inventory/placement entries, 16 reconciliation callbacks, action deadlines, and
  per-page/global result caches; reconnect abort listeners and reservations are released.
- Production advertisement and callers remain disabled. No user-visible browser is activated, and
  old clients, explicit server/offscreen placement, browserless hosts, SSH/WSL routes, folder
  workspaces, and git worktrees retain their current behavior.
- Remaining activation blockers: preserve the concrete client executor across authority
  transition; publish optional placement; route create/agent/CLI commands by placement; add local
  browser chrome and interaction ownership; add mobile mirroring and large-result channels; then
  prove headed/headless/browserless, macOS/Linux/Windows, SSH/WSL, folder/worktree, multi-client,
  containment, and rolling-version journeys behind a kill switch.
- Draft PR [#14769](https://github.com/stablyai/orca/pull/14769) stacks on #14763 and remains draft.
  GitHub auto-attached it to STA-4150; one orchestration checkpoint comment
  (`1153c604-bbb5-4293-af33-cfb4143170c9`) was posted, and the ticket remains In Progress. No PR
  was merged or marked ready.

Current local authority-transition stage:

- Baseline: replacing `authorityRuntimeId` for the same pairing destroyed the composition and its
  retained Electron page inventory. The first production seam made the registry test green while
  Node typecheck remained red because the composition lacked `replaceAuthority`.
- Candidate: old routes suspend and retire synchronously; old navigation grants revoke before
  asynchronous cleanup; old handlers settle before the executor changes connection identity; a
  fresh host and route set then attach the immutable old inventory for close/restore reconciliation.
- Fresh review red/green: a replacement without reconciliation echo previously resolved while
  publishing one old-runtime page. It now fails before replacement route activation and dispatcher
  admission; empty inventory still permits a legacy replacement. An in-flight old-authority create
  previously completed after transition began; it now fails and releases its route. Retired-route
  rejection also closes the composition before replacement activation, while transition revocation
  failure remains fenced and exact cleanup completes.
- SSH constraint: execution-host keys may omit runtime identity, so any runtime change requires
  close-then-restore rather than DOM-preserving reclaim. Same-runtime/new-epoch reclaim remains
  supported.
- Latest-base validation: focused authority/reconciliation coverage passes 9 files / 136 tests;
  reconnect and lease-lifecycle coverage passes 14 files / 169 tests. The paired integration passed
  3/3 before the final rebase and still needs its latest-base rerun; broader affected coverage,
  mixed-version wire, full typecheck/lint/audits, builds, and fresh reviews also remain queued.
- The 40-patch stack rebased conflict-free onto `origin/main@fd1dba9db9`; `git range-diff` marked all
  40 patches identical. Safety tags `sta-4150-safety-pre-paired-fixture-amend-20260816` and
  `sta-4150-safety-pre-fd1-authority-rebase-20260816` preserve the prior tips. No rewritten branch
  has been pushed at this checkpoint.
- No new field or opcode was added. The existing optional reconciliation version is advertised only
  by the otherwise uncalled composed client-host path, must be echoed exactly, and remains inert
  because no production capability advertisement or browser-create caller exists.

Do not promote narrow deterministic evidence into a live-topology claim. Record exact commands,
topology, versions, and explicit gaps at every later checkpoint.

## Public mutation ledger

- Pushed the STA-4150 staged branches listed in the draft-stack table.
- Opened and maintained their linked draft PRs; none were merged or marked ready.
- Attached draft PRs and posted one concise checkpoint per stage on STA-4150.
- Latest public checkpoint: GitHub auto-attached draft PR #14769 and one Linear checkpoint was
  posted; CI is running.
- Updated the Orca worktree comment/status at context, reproduction, fix, validation, and review
  checkpoints.
- Pushed the renderer-bridge branch, opened draft PR #14578 on #14566, attached it to STA-4150,
  and posted one concise checkpoint. The ticket remains In Progress.
- Rebased and pushed all 24 published branches onto `origin/main@e2d309e9cd`; the patch series was
  identical by `git range-diff`, and the rewritten #14578 CI run is in progress.
- Pushed the retained renderer registry and opened draft PR #14596 on #14578; attached it to
  STA-4150 and posted one concise checkpoint. The ticket remains In Progress.
- Pushed the environment-scoped composition and opened draft PR #14613 on #14596; attached it to
  STA-4150 and posted one concise checkpoint. The ticket remains In Progress.
- Pushed the reconciliation semantics and opened draft PR #14617 on #14613. It adds no wire field
  or production caller.
- Rebased all 25 branches onto `origin/main@9bb8836bb6`, confirmed all 26 patches identical before
  the ledger-only amend, and pushed them with lease checks.
- Rebased all 27 branches onto `origin/main@500b72d8ef` and force-pushed them with lease checks.
  Range-diff preserved the first 24 stages; the bridge date was already upstream, and the
  composition delta is the intentional lazy Electron IPC fix.
- Rebased all 28 stack branches onto `origin/main@a3b472d050`, confirmed all 29 patches identical
  by `git range-diff`, and force-pushed them with lease checks.
- Pushed the authenticated inventory stage, opened draft PR #14648 on #14617, attached it to
  STA-4150, and posted one concise checkpoint. The ticket remains In Progress.
- Locally rebased all 30 patches onto `origin/main@e570cade3c`; range-diff preserved every patch.
  Safety pointer `sta-4150-safety-pre-e570-rebase-20260814` retains the prior series. No branch,
  PR, or Linear mutation for this rebase or the reconnect stage had been published at that
  checkpoint.
- Atomically force-pushed all 28 previously published stack branches with exact remote-OID leases,
  pushed `sta-4150-browser-client-host-reconnect-grace`, and opened draft PR
  [#14691](https://github.com/stablyai/orca/pull/14691) on #14648. No PR was merged or marked ready.
- Attached #14691 to STA-4150 and posted one concise reconnect-stage checkpoint. The ticket remains
  In Progress.
- Rebased all 31 patches onto `origin/main@3908978ba4`, confirmed every patch identical by
  `git range-diff`, and atomically force-pushed all 29 prior public branches with exact remote-OID
  leases while creating the retired-frame branch with a must-not-exist lease.
- Opened draft PR [#14694](https://github.com/stablyai/orca/pull/14694) on #14691. No PR was merged
  or marked ready.
- GitHub attached #14694 to STA-4150 automatically; posted exactly one retired-frame checkpoint
  comment and kept the ticket In Progress.
- Locally rebased all 31 published patches plus the admission-fairness patch onto
  `origin/main@5b7f44278a`. No rewritten branch, new branch, PR, or Linear mutation has been
  published at this checkpoint.
- Atomically force-pushed all 30 existing public stack branches with exact remote-OID leases and
  created `sta-4150-browser-host-admission-fairness` with a must-not-exist lease. The first local
  refspec construction failed before any remote update; the corrected atomic transaction updated
  all 31 refs together.
- Opened draft PR [#14747](https://github.com/stablyai/orca/pull/14747) on #14694. Its initial
  inline shell argument expanded Markdown backticks; immediately replaced the description through
  literal stdin and verified the final title, body, base, head, and draft state.
- GitHub auto-attached #14747 to STA-4150. Posted exactly one admission-fairness checkpoint comment
  and kept the ticket In Progress.
- Pushed `sta-4150-browser-lease-fence-placement-retirement` with a must-not-exist lease and opened
  draft PR [#14753](https://github.com/stablyai/orca/pull/14753) on #14747. No existing stack branch
  changed, and no PR was merged or marked ready.
- GitHub auto-attached #14753 to STA-4150. Posted exactly one lease-retirement checkpoint comment
  (`99343f4d-a584-46fd-94ab-fc8d004e738b`) and kept the ticket In Progress.
- Pushed `sta-4150-browser-navigation-grant-lease-fencing` with a must-not-exist lease and opened
  draft PR [#14754](https://github.com/stablyai/orca/pull/14754) on #14753. No prior stack branch
  changed, and no PR was merged or marked ready.
- GitHub auto-attached #14754 to STA-4150. Posted exactly one navigation-fence checkpoint comment
  (`6ea865bf-8003-435a-8600-9ec11fd21577`) and kept the ticket In Progress.
- Pushed `sta-4150-browser-page-reconciliation-execution` with a must-not-exist lease and opened
  draft PR [#14756](https://github.com/stablyai/orca/pull/14756) on #14754. No prior stack branch
  changed, and no PR was merged or marked ready.
- GitHub auto-attached #14756 to STA-4150. Posted exactly one reconciliation-executor checkpoint
  comment (`3957ea40-a9e2-4b25-9197-2f972166f47b`) and kept the ticket In Progress.
- Updated the Orca worktree comment after validating the reconciliation-command-contract candidate.
- Locally rebased all 36 STA-4150 patches onto `origin/main@931cb037c5` and confirmed every patch
  identical by `git range-diff`. Safety pointer `sta-4150-safety-pre-931c-rebase-20260815` retains
  the pre-rebase series. No rewritten branch or new stage branch has been pushed at this checkpoint.
- Atomically force-pushed all 34 existing public stack branches with exact remote-OID leases and
  created `sta-4150-browser-reconciliation-command-contracts` with a must-not-exist lease. The
  first local count assertion expected 35 published branches and failed before invoking `git push`;
  the corrected 34-branch transaction updated all refs together.
- Opened draft PR [#14759](https://github.com/stablyai/orca/pull/14759) on #14756. GitHub
  auto-attached it to STA-4150; posted exactly one reconciliation-contract checkpoint comment
  (`b775afbd-fb75-42bf-bee3-8d8ca0877b33`) and kept the ticket In Progress.
- Locally cascade-rebased all 36 published patches plus the reconciliation-adapter patch onto
  `origin/main@c4e397bcdc`; range-diff marked all 37 patches identical. Safety pointer
  `sta-4150-safety-pre-c4e-rebase-20260815` retains the prior series. No rewritten branch or new
  stage branch has been pushed at this checkpoint.
- The first atomic-push command constructed invalid zsh refspecs and failed before any remote
  update. The corrected transaction atomically force-pushed all 35 existing public stack branches
  with exact remote-OID leases and created `sta-4150-browser-page-reconciliation-adapters` with a
  must-not-exist lease.
- Opened draft PR [#14763](https://github.com/stablyai/orca/pull/14763) on #14759. GitHub
  auto-attached it to STA-4150; posted exactly one reconciliation-adapter checkpoint comment
  (`de3e18d0-c24d-433b-ad67-3943c68d4129`) and kept the ticket In Progress.
- Atomically force-pushed all 36 existing published stack branches with exact remote-OID leases and
  created `sta-4150-browser-reconciliation-orchestration` with a must-not-exist lease. Opened draft
  PR [#14769](https://github.com/stablyai/orca/pull/14769) on #14763.
- GitHub auto-attached #14769 to STA-4150. Posted exactly one orchestration checkpoint comment
  (`1153c604-bbb5-4293-af33-cfb4143170c9`) and kept the ticket In Progress.
- Locally committed #14769's bounded-deadline assertion fix and the authority-transition stage,
  then cascade-rebased all 40 patches and 37 local stack refs onto `origin/main@d2ffe1f362` with an
  exact 40/40 range-diff. No rewritten branch, new PR, GitHub comment, Linear mutation, or status
  change has been published at this checkpoint.
- Rebased the activated cumulative feature onto `origin/main@9f3a912c1e`, preserved safety refs,
  and proved the final tree with 53,861 tests, full typecheck/lint/audits, 89 reliability gates,
  a fresh desktop build, paired headed Electron E2E, real headless `orca serve` E2E, Electron/CDP
  inspection, and three independent final reviews with no remaining proven P0/P1/P2.
- Reshaped the exact validated tree into draft PRs #14953-#14957, pushed the five landing branches,
  created GitHub stack #14958, and updated every PR title/body with scope, validation, compatibility,
  and the complete old-to-new mapping. All PRs remain draft; none was merged or marked ready.
- PR #14955 CI deterministically exposed a misplaced renderer-id test fixture. The exact test was
  red 1/9, the corrected test passed 9/9, and the matching Node 24 shard passed 3,407 tests with
  seven skips. Moving that correction to the lifecycle layer and cascading the upper branches
  preserved the prior top tree exactly.
- PR #14957 CI's updated React Doctor found two render-time callback-ref writes. Replacing them with
  React 19 effect events passed the focused component tests 4/4, web typecheck, the exact changed
  React Doctor gate, and all 46 required PR checks. A transient Windows daemon socket observation
  failed on the superseded run; the fresh run passed without a code change to that subsystem.
- All five replacement PRs are green. GitHub auto-attached #14957 to STA-4150, so no duplicate
  attachment was created. One Linear checkpoint comment (`7b65415a-ec0d-4cb4-836d-ea13dcc4893f`)
  was posted, the ticket remains In Progress, and the Orca worktree comment records the green stack
  and explicit validation gaps.
- The superseded development drafts remain open until human reviewers accept the replacement
  stack. Their mapping is durable in #14957; closing them now would remove useful review evidence.
- No PR was merged or marked ready.
- Rebased all five replacement branches onto `origin/main@9e3e583a83` and resubmitted stack
  #14958. The conflict resolution kept upstream `skills.install-result.v2` on every native remote
  transport, added Electron browser capabilities only for Electron callers, preserved upstream
  abort semantics, and retained both renderer bootstrap installers. No PR was merged or marked
  ready, no superseded draft was closed, and Linear remained In Progress.

## Completion rule

STA-4150 is complete only when the full acceptance matrix is proven on the activated,
capability-negotiated path while old clients and explicit server/offscreen placement still pass.
A green inert unit-test stack, a mounted local webview without remote routing, or a compatibility
fix to the old server-hosted path is not completion.
