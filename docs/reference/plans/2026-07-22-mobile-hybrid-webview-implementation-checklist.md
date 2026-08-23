# Mobile Hybrid WebView Completed-Work and Evidence Index

- **Scope:** Completed candidate implementation through 2026-08-23
- **Status:** Implementation record, not a production-readiness claim
- **Open work:** [remaining-work tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md)
- **Decisions:** [migration record](2026-07-22-mobile-hybrid-webview-single-pr-migration.md)
- **Ownership:** [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md)
- **Operations:** [rollback runbook](../mobile-hybrid-webview-rollback.md)

This index replaces the execution-era checklist. Completed rows mean the named
implementation and recorded candidate evidence exist. They do not close
physical-device, store, signed-release, production cloud Relay, cross-version,
performance, accessibility, or production-promotion gates.

## Provenance

| Record                                     | Value                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Initial migration                          | `9834f65552`                                                       |
| Audit plan                                 | `06f23ec818`                                                       |
| Candidate checkpoint                       | `e931b2db07`                                                       |
| `origin/main` and merge base at checkpoint | `4c984d4c1b`                                                       |
| Checkpoint comparison                      | 81 commits; 1,396 files; 140,153 additions; 8,772 deletions        |
| Post-audit integration checkpoint          | `b14fe74214`                                                       |
| Current `origin/main` checkpoint           | `b2902cb61e`                                                       |
| Post-audit comparison                      | 89 commits; 1,401 files; 134,626 additions; 8,771 deletions        |
| Latest verified package                    | `121fe8682fc221fd7e6f2955fe1f246017d164db3122d71526bc3f66b19578c5` |
| Latest package size                        | 51 assets; 9,151,993 raw bytes; 2,649,166 gzip bytes               |

Commit and branch counts are historical evidence for that checkpoint; rerun
`git merge-base origin/main HEAD`, `git rev-list --count origin/main..HEAD`, and
`git diff --stat origin/main...HEAD` before using them in a release record.

## Completed Implementation

| Area                | Completed result                                                                                                                                                     | Durable evidence                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture        | Stable native shell plus Desktop-served RNW workspace package; native and Desktop authority split frozen                                                             | [Architecture](../mobile-hybrid-webview-architecture.md) and [migration record](2026-07-22-mobile-hybrid-webview-single-pr-migration.md) |
| UI source           | Duplicate web presentation removed; existing RN screens/components shared through native/web adapters                                                                | `a7dcd591b9`; [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md)                                                   |
| Cutover             | Home, onboarding, notifications, cold resume, workspace, and exact-session entry use the production hosted route; native host editing remains native                 | `0a91c04a49`, `ce43d114be`, `7815f3afb3`, retired-name gates                                                                             |
| Build               | Deterministic RNW manifest/document/assets, CSP, size report, and independent verifier integrated with Desktop packaging                                             | `pnpm build:mobile-web-rnw`                                                                                                              |
| Delivery            | Authenticated `mobileWeb.package.*` methods work over paired Direct and local protocol-compatible Relay composition                                                  | Hosted WebView E2E commands below                                                                                                        |
| Cache               | Exact manifest/activation parsing, bounded reads, path/symlink defense, concurrency, atomic host-scoped active/previous generations, corruption recovery             | `0a247f9743`, `9b9c76222f`, and cache/security test groups                                                                               |
| Private origin      | iOS custom scheme and Android fixed HTTPS origin enforce declared assets, CSP, navigation, download, popup, service-worker, and network isolation                    | iOS/Android security journeys below                                                                                                      |
| Bridge              | Exact v2 contract, named operations, generated grants/schemas/bounds, opaque authority, mutation reauthorization, response correlation, lifecycle cleanup            | `548d8d64aa`, `e526780848`, `b2068661f7`, `ee15298704`, `2094dde1f9`                                                                     |
| Routes              | Workspace, Accounts, Tasks, Session, Agent History, Files/Preview, Source Control, and Review use explicit hosted adapters                                           | [Parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md)                                                                 |
| Terminal            | Real xterm/PTY byte path, bounded ACK/backpressure, links, selection/paste, reconnect/resnapshot, SSH recovery                                                       | Direct, SSH, and packaged SSH E2E commands                                                                                               |
| Native capabilities | Gesture/permission/foreground-mediated clipboard, documents/photos, haptics, external URLs, speech/audio, settings, and diagnostics                                  | iOS/Android capability journeys and focused tests                                                                                        |
| Privacy             | Credentials, endpoints, paths, durable host identity, page payloads, and full build IDs excluded from page authority, storage, logs, cache identity, and diagnostics | `8ee4fcdac1`, `d6b8b14c82`, exact-app privacy audits                                                                                     |
| Security review     | 2026-08-21 independent OpenCode review covered bridge, shells, package store, runtime RPC, Relay, and SSH; high-severity findings fixed                              | Review record summarized below; not physical/store certification                                                                         |
| Rollback            | Automatic active/previous recovery, process-loss rollback, host-scoped manual recovery, and corrected Desktop/native incident procedure                              | [Rollback runbook](../mobile-hybrid-webview-rollback.md)                                                                                 |

## Reproducible Command Index

Run from the repository root unless noted.

| Purpose                                   | Command                                                           | Recorded scope                                                          |
| ----------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Build and independently verify package    | `pnpm build:mobile-web-rnw`                                       | Manifest, content hashes, assets, CSP, roles/MIME, limits, size report  |
| Typecheck hosted package                  | `pnpm typecheck:mobile-web`                                       | Hosted entry, adapters, schemas                                         |
| Lint hosted package                       | `pnpm lint:mobile-web`                                            | Hosted package and verifier                                             |
| Mobile unit/integration suite             | `pnpm --dir mobile test`                                          | Native/hosted adapters, bridge, cache, lifecycle, route fixtures        |
| Mobile typecheck                          | `pnpm --dir mobile typecheck`                                     | Expo/native and shared RN sources                                       |
| Mobile lint                               | `pnpm --dir mobile lint`                                          | Mobile production and test sources                                      |
| Direct actual-WKWebView journey           | `pnpm test:e2e:hosted-mobile-webview`                             | Package delivery, hosted UI, real bridge, Direct desktop                |
| Docker SSH actual-WKWebView journey       | `pnpm test:e2e:hosted-mobile-webview:ssh`                         | Execution-owner boundary, terminal mutation, native chat, reconnect     |
| Packaged macOS arm64 to Docker SSH        | `pnpm test:e2e:hosted-mobile-webview:ssh:packaged`                | Packaged resource lookup through actual WKWebView; no checkout fallback |
| iOS hosted journey                        | `pnpm --dir mobile test:e2e:hosted-webview`                       | Route/capability/reconnect simulator journey                            |
| iOS hostile-content journey               | `pnpm --dir mobile test:e2e:hosted-webview:security`              | Network/navigation/executable/storage isolation                         |
| Android route journey                     | `pnpm --dir mobile test:e2e:hosted-webview:android-routes`        | Hosted Source Control/Review and route interactions                     |
| Android hostile-content journey           | `pnpm --dir mobile test:e2e:hosted-webview:android-security`      | Executable/network/navigation/privacy isolation                         |
| Android locally signed Release inspection | `pnpm --dir mobile test:e2e:hosted-webview:android-release`       | Local Release WebView behavior only; not Play signing                   |
| iOS process-loss rollback                 | `pnpm --dir mobile test:e2e:hosted-webview:ios-crash-loop`        | Repeated WebView loss and generation recovery on Simulator              |
| Android process-loss rollback             | `pnpm --dir mobile test:e2e:hosted-webview:android-crash-loop`    | Emulator crash-loop recovery                                            |
| Android cache corruption                  | `pnpm --dir mobile test:e2e:hosted-webview:android-corrupt-cache` | Corrupt active generation recovery                                      |
| Native iOS package-store tests            | `pnpm --dir mobile test:native:ios-web-store`                     | Swift verification/cache behavior                                       |

`SKIP_BUILD=1` may be used only when the exact package under test was built and
recorded immediately beforehand. Release evidence must record commit, Desktop
artifact, mobile artifact, package build ID, device/runtime, topology, command,
and raw result location.

## Package and Topology Evidence

- Latest independent verification:
  `121fe8682fc221fd7e6f2955fe1f246017d164db3122d71526bc3f66b19578c5`,
  51 assets, 9,151,993 raw bytes, 2,649,166 gzip bytes.
- Packaged macOS arm64 Desktop through an isolated Docker SSH provider to an
  actual iOS WKWebView used
  `7c7c673deb74e158cdfb99b1ca536fd88cd3ab5dac4eb8db78c43ca12f6ce31d`.
  It verified package identity, terminal mutation, native-chat publication,
  disconnect retention, PTY/provider reattachment, and transcript recovery
  without a checkout fallback.
- Direct iOS Simulator journeys exercised real package RPC, private origin,
  bridge, route presentation, terminal input/output, attachments, native
  capabilities, reconnect, and cold restore.
- A deterministic protocol-compatible local Relay cell carried the production
  mobile Relay session, NaCl E2EE v2, Desktop `CloudRelayTransport`, package
  provider/downloader, hosted operations, and terminal/native-chat flows.
  This is composition evidence, not production cloud Relay validation.
- Classic SSH transcript authority and reconnect ran through the real Docker
  provider. WSL, folder-workspace breadth, multi-host races, and the supported
  topology matrix remain open.

## Route and Presentation Evidence

The [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md) is
the complete ownership and route record. Historical screenshot figures are not
current evidence: the prior production cutover redirected native `/h/**`
workspace routes into Hybrid, so that run could compare hosted output against
hosted output. `7815f3afb3` added a development-only native baseline and CDP
assertions before and after every native capture; `2094dde1f9` makes the
assertion fail closed when more targets exist than it can inspect. Corrected
native-versus-hosted results must replace the invalidated figures before parity
certification. Simulator evidence will still not close physical-device,
accessibility, input, or performance gates.

## Security and Lifecycle Evidence

- TypeScript, Swift, and Kotlin share exact path, hash, MIME/role, manifest,
  activation, chunk, CSP, bridge-token, and size-limit corpora.
- Native stores reject oversized and non-exact JSON, duplicate decoded keys,
  malformed/lone surrogates, trailing input, excessive depth, coercions,
  traversal, symlinks, linked parents, unexpected file types, and out-of-root
  reads before activation. Mirrored concurrency tests cover same-host stage,
  activation, cleanup, commit/abort, and removal races.
- All 224 recorded production grants rejected eight malformed request shapes
  plus an oversized request before native/host access: 2,016 cases. Exported
  results and subscription events have invalid-payload admission coverage;
  invalid events retire their subscriptions.
- Cross-build/session tests cover a 15-pair stale authority grid. Cancellation,
  client replacement, disposal, replay, late subscription registration, and
  delayed mutation results fail closed.
- Exact iOS and Android emulator apps rendered hostile filenames, diffs,
  terminal links, provider/task strings, errors, Markdown, HTML, SVG, Mermaid,
  and image metadata inertly, with no execution marker or sentinel traffic.
- Exact-app audits inspected DOM/history, local and session storage, cookies,
  native logs, crash/exit records, network observations, and navigation. No
  credential, endpoint, path, host identity, or executable escape was accepted
  within the recorded emulator corpus.
- Automatic recovery covered corruption and repeated process loss. The iOS
  Simulator candidate-to-final three-crash drill restored the verified previous
  generation. Final physical/store-signed rollback drills remain open.
- The 2026-08-21 independent OpenCode review found issues in live bridge/native/
  package/runtime RPC/Relay/SSH boundaries. High-severity findings were repaired,
  including bounded SSH/Relay methods, connection-owned file-watch teardown,
  and credential-query redaction. Exact store-signed corpus and broader live
  race/allocation review remain open.

## Evidence Interpretation

The latest recorded full mobile validation passed 599 mobile files and 3,568
tests with two expected skips, plus mobile typecheck/lint/format and diff
hygiene. Root typecheck/lint/code-quality, 56 reliability gates, localization,
and max-lines also passed at that checkpoint. Rerun current CI before release;
historical counts are not evergreen.

No entry in this document claims the following passed: physical phones or
tablets, production-store-signed apps, Windows/Linux/headless packaged Desktop,
production cloud Relay, the real mixed-version matrix, final accessibility and
input review, physical-device performance or endurance, final release rollback,
or App Review. Those items live only in the
[open-gate tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md).
