# Mobile Hybrid WebView Remaining Work

- **Status:** Hybrid-only candidate implementation complete; external release
  validation and production promotion remain
- **Last updated:** July 29, 2026
- **Detailed evidence archive:**
  [`2026-07-22-mobile-hybrid-webview-implementation-checklist.md`](./2026-07-22-mobile-hybrid-webview-implementation-checklist.md)
- **Migration design:**
  [`2026-07-22-mobile-hybrid-webview-single-pr-migration.md`](./2026-07-22-mobile-hybrid-webview-single-pr-migration.md)
- **Parity inventory:**
  [`2026-07-22-mobile-hybrid-webview-parity-inventory.md`](./2026-07-22-mobile-hybrid-webview-parity-inventory.md)

This is the active tracker. It contains only work that remains. Remove an item
when it is completed and record its evidence in the detailed checklist.

## Current Checkpoint

The production package, verified cache, private WebView origin, typed bridge,
workspace/session/terminal/files/tasks/accounts/browser/dictation/native-chat,
Agent History, Source Control, and Review foundations exist. The hosted routes
reuse the current React Native presentation through React Native Web; there is
no replacement product UI.

Hosted feature implementation is complete. Broad validation, independent
security review, physical-device performance, and App Store acceptance remain
open. The dedicated candidate exposes only the hybrid workspace architecture.

The production entry now routes Home host selection, exact-session resume,
Tasks, Accounts, New Workspace, pairing completion, onboarding completion,
notification navigation, and cold resume into the production hybrid shell
unconditionally. Restored legacy `/h/...` shell routes redirect to `/hybrid`.
Transient shell destinations are not persisted as cold-resume state.

The obsolete `hybrid-prototype` route, prototype package/cache/bridge
implementation, prototype RPC methods and allowlist entries, shared prototype
contract, and their fixtures are removed. The route flag, Experimental Settings
entry, and native workspace destination are also removed. The shared
`mobile/app/h/` modules remain solely as source imported by the hosted React
Native Web package.

Cutover cleanup validation passes 600 mobile files / 3,567 tests with 2
expected skips, mobile and root typechecks, mobile and root lint, native and
type-aware code-quality audits, 56 reliability gates, max-lines, localization,
formatting, and diff hygiene.

The exact iPhone 17 Pro Simulator app now passes the hosted Source Control and
Review journey. The unchanged Session-origin flow opens a changed file as a
second Session diff tab, while standalone Review is verified separately with
its existing Back and review-actions controls. The same run passes the private
origin network and navigation isolation probes.

The exact Pixel 9 Pro API 36 arm64 Debug APK now passes the same journey after a
fresh native build and install. Android accessibility enters the unchanged
Source Control UI, opens a changed file as a second Session diff tab, and
verifies standalone Review. The deliberate-red network/navigation isolation
probe records zero escaped traffic, and the embedded log audit records no Expo
bridge rejection, Kotlin conversion/cast error, or fatal process error.

The Android route gate now also seeds a disposable Agent History fixture and
verifies the unchanged screen's Workspace/Project/All scopes, lazy preview,
search/no-match/clear flow, rejection of synthetic privileged activation, and
native-touch resume into a second Session tab before continuing through Source
Control and Review.

A disposable repository now drives a hostile filename and changed diff line
through the real Source Control, Session diff, and Review routes. The exact
iPhone 17 Pro / iOS 26.5 Simulator app and Pixel 9 Pro API 36 arm64 Debug app
both render the `<img onerror>` payloads literally, create no matching image,
leave both execution sentinels unset, and pass the existing
network/navigation/executable and privacy audits. The fixture uses only the
broker-issued opaque page workspace authority; raw Desktop workspace identity
never enters the hosted URL. The same exact apps traverse the unchanged
Files/Preview UI with hostile Markdown, HTML, and SVG files. Markdown preview
and source plus HTML/SVG source remain inert, create no injected
`data-orca-adversarial` element, leave all execution sentinels unset, and make
zero loopback-sentinel requests. A valid 1×1 PNG whose `tEXt` metadata carries
script-shaped content and the same sentinel URL also decodes through the real
RNW image surface on both exact apps without exposing metadata, executing its
marker, or making a request. Both exact apps also pass the live hostile
terminal-link corpus: JavaScript links stay inert, no HTTP request occurs
without a tap, and a native tap opens the allowlisted file target through the
unchanged Session presentation. The Android emulator additionally passes
hostile Tasks provider text, a bounded provider error, and normal, malicious,
and invalid Mermaid through the exact app. Physical-device, store-signed
release-runtime, and independent review coverage remain open.

The iPhone 17 Pro / iOS 26.5 Simulator now captures the unchanged native and
hosted Tasks and Session screens from one disposable Desktop runtime. Tasks
passes at 0.022% changed pixels, 0.084 mean channel difference, and 0.000016
vertical-title delta. Session passes at 0.800%, 1.693, and 0.000366
respectively, within the 3%, 4, and 0.005 budgets. The same fresh exact-app run
passes Agent History portrait/landscape parity, Desktop restart and recovery,
native-touch resume, a third Session diff tab, standalone Review, and both
isolation probes.

The existing non-embedded Tasks toolbar icon has no native accessibility label.
The fixture locates its unchanged row from the accessible Filter control and
uses the existing icon position. This is recorded as an accessibility finding,
not treated as a reason to change product UI inside the migration.

The same exact-app iOS gate now covers the unchanged Files route and a real
Preview navigation through `Casks/orca.rb`. Files passes at 0.030% changed
pixels and 0.128 mean channel difference; Preview passes at 0.061% and 0.274.
Both cached-app and fresh Xcode build/install journeys pass the complete route,
recovery, review, and isolation matrix. Equivalent hosted route values no
longer restart Preview loads, and RNW preserves the native iOS font fallback.

The unchanged Accounts screen now also passes deterministic iOS
native-versus-hosted parity at 0.050% changed pixels, 0.099 mean channel
difference, and 0.000544 vertical-title delta, within the 3% / 4 / 0.005
budgets. Its existing non-embedded toolbar icon now exposes a nonvisual `Tasks`
accessibility label without changing layout or styling. The exact Android
fixture locates that control semantically and retries only after proving the
route did not open. The complete cached-app journey passes with Accounts
inserted before Tasks, Session, Files/Preview, Agent History, Desktop
restart/recovery, Source Control, Review, and both isolation probes.

The base workspace screen now has the same deterministic proof. Native and
hosted mount the unchanged `HostScreen` and pass at 0.879% changed pixels,
1.876 mean channel difference, and 0.000395 vertical landmark delta against the
3% / 4 / 0.005 budgets. The complete journey captures this screen before
Accounts and the rest of the route matrix.

The unchanged Source Control and Review screens now also have scale-correct
parity evidence against the real 1,294-file branch comparison. The Desktop
serves revision-consistent pages of at most 128 entries with a 4,000-entry
aggregate ceiling, and the hosted adapter assembles those pages without
changing the presentation. Native and hosted both show `0/1294 reviewed`, the
same first file, and the same diff. Source Control passes at 0.736% changed
pixels and 0.910 mean channel difference; Review passes at 2.134% and 1.947,
within the 3% / 4 budgets. The packaged document opts into native safe-area
insets, and nested syntax text retains the native effective font behavior.

The migration is based on `origin/main` at `3eddc467cf`; the final rebase is
complete and the branch is 65 commits ahead and zero behind. Post-rebase
validation plus the hostile-content slice now passes 599 mobile files / 3,568
tests with 2 expected skips. The earlier broad runtime slice passes 13 files /
906 tests across SSH recovery generations, daemon PTY behavior, terminal
recovery/IME, and remote skill discovery; current-base validation of the
affected SSH recovery/session paths passes 5 files / 62 tests. The latest full
root run passes 40,515 tests apart
from one unrelated load-sensitive transcript watcher assertion whose 28-test
file passes standalone. All project typechecks,
root/mobile/mobile-web lint and code-quality audits, 56 reliability gates,
changed-file and full-mobile formatting, localization, the max-lines ratchet,
and diff hygiene pass. React Doctor reports zero new migration findings. The
independently verified React Native Web package is
`121fe8682fc221fd7e6f2955fe1f246017d164db3122d71526bc3f66b19578c5`:
51 assets, 9,151,993 raw bytes, and 2,649,166 gzip bytes. The final
build-inclusive exact Android journey returns `ok: true` after Agent History,
Source Control/Review, and the complete isolation corpus, with zero sentinel
observation, bridge-log finding, or new failure exit record. Workspace
activation waits for the native recovery surface to settle and taps the stable
visible row instead of the non-hittable Android WebView ARIA node.

The immediately preceding `7c7c673d…` package passed the unpacked macOS arm64 →
Docker SSH → actual iOS WKWebView journey from a clean app reinstall in 1.9
minutes. Authenticated RPC returned the packaged build with no checkout-output
fallback; the unchanged mobile UI mutated the remote terminal, rendered a
remote native-chat transcript, retained it during provider loss, and rendered
the appended assistant message after reconnect. The harness seeds the
pasteboard before Session snapshots clipboard availability, uses the existing
opaque clipboard-paste capability and Enter accessory, retries one missed
native activation, and stops after the first captured request. Two focused
retry tests pass. It does not depend on or change the simulator's keyboard
layout.

The latest native-authority audit keeps the unchanged UI but removes hosted
fallback access to Expo clipboard, image/document pickers, haptics, and direct
external-link opening. Native routes receive platform-resolved adapters;
hosted routes fail closed or use the gesture-gated capability bridge.
Native-chat tool input is normalized before schema parsing and delivery to a
4,000-character, 100-node, 20-item, five-level budget. A deterministic
adversarial corpus now covers filenames, diff lines, task/provider fields,
bounded errors, terminal-link policy, and the remaining intentional sanitized
HTML/Markdown/Mermaid sinks.

The worktree-local dev runtime now passes a fresh exact-app iPhone 17 Pro
security rerun without the production-runtime `host_forbidden` mismatch. The
same exact cached app seeds the simulator pasteboard, enters the unchanged
Session UI, activates its existing Paste control through a native accessibility
tap, accepts the real iOS paste privacy prompt, and requires the exact
`ORCA_HOSTED_CLIPBOARD_TEXT_PASTE` marker in the temporary Desktop terminal.
The successful run used two bounded activation attempts and then passed the
private-origin network and navigation isolation probes.

The same gate now resets only Orca's Photos permission before launch and denies
the real iOS prompt from the unchanged Attach control. The existing
`Photo permission denied` toast appears, the exact hosted Session stays active,
Desktop terminal output remains unchanged, no image data or `orca-paste-` path
marker appears in hosted page text, and both isolation probes pass. Focused
contract tests separately require the bridge result to contain status only.
The same exact-app journey now long-presses unchanged Attach, opens Files,
selects a deterministic 123-byte PNG, and requires the shell-owned host upload
to inject its temp path through the terminal stream. Independent size and
SHA-256 checks match the source; the filename, bytes, digest, and host path are
absent from hosted page state. The picker uses native touch plus the existing
React Native Web responder because physical WebKit touch alone does not
reliably dispatch the shared long-press handler on iOS 26.5.

Post-grant Photos revocation now passes in a focused exact-app journey. iOS
terminates Orca after the grant and again after revocation; the harness
re-enters through the existing native Settings handoff and requires the same
semantic Session/workspace after each restart. The private WebView origin and
shell-issued opaque workspace authority rotate both times. After revocation,
unchanged Attach shows `Photo permission denied`, Desktop terminal output stays
unchanged, no privileged marker enters page text, and the network/navigation
isolation probes pass.

The same focused journey now covers picker interruption. Sending the real
Photos picker to Home and foregrounding Orca resumes that picker rather than
cancelling it. Explicit Cancel returns to the same hosted Session with the
private origin and opaque workspace authority retained. The journey then
completes revocation with unchanged terminal output, no privileged page marker,
and both isolation probes passing.

A focused exact-app iPhone 17 Pro / iOS 26.5 run now also copies the existing
48×48 PNG through Photos, accepts the real iOS paste privacy prompt from the
unchanged Paste control, and requires a shell-owned host temp path in the
Desktop terminal. The 411-byte Photos encoding matches the source RGBA SHA-256
`a2773eaed936229595e49669b8705cb179a6a004a48a4d8304d6ee2710ab26b9`.
The filename, path, pixel digest, encoded prefix, and `data:image/` marker stay
out of hosted page text, and both isolation probes pass.

Fresh exact-app iOS and Android emulator gates now prove that the active
manifest-declared content-addressed RNW script loads while a mutated undeclared
same-origin script is rejected by the native manifest store. The hosted
document remains intact, both platforms retain network/navigation isolation,
and Android records zero sentinel observations plus a clean native bridge log.
Manifest and package-RPC schemas now share one exact asset-path predicate. A
mirrored TypeScript, Swift, and Kotlin corpus rejects empty, absolute,
traversal, repeated-separator, percent-encoded, query, fragment, backslash,
non-ASCII, overlong, and trailing-newline paths.
Shared application SHA-256, Git object ID, bridge/session ID, domain token, and
base64 schemas now require full-string matches through one protocol-token
contract. The directly loaded manifest applies the same exact hash rule
locally, and the mirrored native SHA corpus enforces it on Swift and Kotlin.
The manifest now exports the exact extension/MIME/role map. Source-parity tests
require both native maps to match, and all three runtimes pass the same eight
valid and eight mutated metadata cases.
Both native stores now read persisted manifests with the 256 KiB ceiling,
activation metadata with a 1 KiB ceiling, and assets with their exact declared
length plus one overflow byte. Oversized files fail with the existing stable
generation or activation error before whole-file allocation; mirrored Swift
and Kotlin fault suites pass.
The obsolete standalone `src/mobile-web/` presentation and Vite-only package
path are removed. The directory now contains only production bridge clients,
transport state, and focused tests consumed by the real React Native Web route
graph. A source boundary prevents the duplicate renderer-based UI from
returning, and the production package remains build `b17ead7a…`.
Post-removal validation passes 568 mobile files / 3,375 tests with 2 expected
skips and 3,752 root files / 39,218 tests with 62 expected skips. Root, mobile,
and mobile-web lint; node, mobile, and mobile-web typechecks; reliability,
localization, max-lines, formatting, package verification, and diff hygiene
pass. The packaged-resource fixture now includes the same required safe-area
viewport contract as the production document.
The first production bridge policy is now frozen: packages and the shell use
the exact v2 protocol, additive features use capability negotiation instead of
version bumps, and Desktop must retain a bridge floor for at least two stable
mobile releases containing its replacement before the supported shell minimum
can advance. Packaging consumes the shared policy directly.
The production rollback runbook now separates Desktop package incidents from
native-shell/store incidents, requires corrected verified release artifacts,
maps every host-scoped recovery action, forbids manual cache mutation, and
defines privacy-safe support evidence. Final physical-device and store-signed
rollback drills remain open below.
The canonical architecture reference and mobile developer README now document
the shared React Native UI, native/Desktop/hosted ownership, authenticated
package flow, private origins, capability bridge, compatibility policy, gated
rollout, emulator workflow, privacy-safe support intake, troubleshooting, and
recovery. The rollback runbook cross-links the same boundaries.
All six changed Markdown files pass formatting and relative-link resolution;
the rollback/runbook contract passes three focused tests, the installed Orca
CLI confirms the documented emulator commands, and diff hygiene passes.
Post-runbook validation passes 569 mobile files / 3,378 tests with 2 expected
skips. Mobile and mobile-web typechecks/lints, reliability, max-lines,
formatting, diff hygiene, and the unchanged `b17ead7a…` package verification
pass.
Native activation metadata now consumes one exact object on both platforms.
The mirrored two-valid/twelve-invalid corpus closes unknown fields, null and
non-string hashes, identical active/previous generations, duplicate keys, and
trailing tokens.
The iOS native fault executable, Android Debug unit/Release Kotlin gates, and
the same broader validation pass.
Persisted native cache reads now require a regular descendant of the cache
root before opening staged assets, manifests, activation metadata, or committed
assets. Mirrored Swift/Kotlin faults reject outside-root, symlinked,
non-regular, and missing paths with a stable error. Mutation and cleanup fuzzing
remains open below.
Primary/canonical manifests and activation metadata now pass the same exact
JSON grammar before platform parsing. Literal and escaped-equivalent duplicate
keys, nested duplicates, trailing tokens, malformed scalars, and nesting beyond
32 levels fail consistently in the mirrored native corpora.
Cache cleanup now uses a cache-root-boundary deletion path on Android instead
of `File.deleteRecursively()`, which followed a staged directory symlink during
the fault probe and removed an external sentinel. Cleanup, abort, duplicate
commit, unused-generation removal, quota eviction, host removal, and activation
temp cleanup no longer follow linked trees. Quota accounting and eviction also
ignore linked generations. Mirrored iOS/Android faults cover direct and nested
orphan links, live stages replaced by links, host-subtree links, and dangling
host links; the dangling probe also closed an iOS `fileExists` removal skip.
The iOS native fault executable, Android Debug unit/Release Kotlin gates,
569-file mobile suite, mobile/mobile-web typechecks and lints, reliability,
max-lines, focused formatting, diff hygiene, and unchanged `b17ead7a…` package
verification pass after the cleanup repair.
Native cache writes now use the same no-link boundary before opening staged
assets or an activation host tree. Mirrored mutation faults replace an asset,
activation file, and whole host tree with symlinks. Staged and host-tree writes
fail with stable errors, while atomic activation replacement removes the
in-cache link rather than modifying its external target.
The 569-file mobile suite, mobile/mobile-web typechecks and lints, reliability,
max-lines, focused formatting, diff hygiene, and unchanged `b17ead7a…` package
verification also pass after the write-boundary repair.
The exact native JSON grammar now validates Unicode surrogate pairing before
Foundation or `org.json` parsing. Escaped pairs and raw supplementary
characters pass, while lone, reversed, or high/high surrogate escapes fail in
keys and values. Mirrored corpora also prove the exact 32-level acceptance and
33-level rejection boundary.
The 569-file mobile suite, typechecks, lints, reliability, max-lines, focused
formatting, diff hygiene, and unchanged `b17ead7a…` package verification remain
green after the parser repair.
Raw bridge messages, including the first shell `init`, now pass an exact
unique-decoded-key, paired-surrogate, single-document, 32-level JSON grammar
before parsing. A generated corpus rejects eight malformed payload shapes and
one oversized request for each of the 224 production grants: 2,016 cases before
host RPC, native access, or subscription setup. It closed account subscription
parsing plus speech/native/navigation validation-order gaps. More than 1,200
valid success envelopes with invalid payloads cross 157 exported result
schemas; all eight subscription event schemas also retire invalid events.
Pending terminal/native-chat subscriptions recheck request liveness after
asynchronous resolution; focused races cover early unsubscribe, authenticated
client replacement, disposal, and replay.

The hosted mutation audit now reauthorizes the exact workspace, repository,
task target, native-chat session, or Agent History session immediately before
every privileged write. Deterministic races remove or replace that authority
during awaited file, provider, Source Control, workspace-creation, browser,
task, native-chat, and Agent History preflight and prove that no stale write or
command injection follows. Agent History also rechecks between terminal
creation and command injection.

Package/cache namespaces and hosted drafts, pending deliveries, Markdown
drafts, and reset-attempt journals now use the paired Desktop public key.
Mutable profile IDs remain only for non-privileged navigation, diagnostics,
and host selection.

Page-side response admission now rejects 25 schema-valid semantic mutations:
wrong workspace, tab, repository, task target, provider/project host, account
reset scope, speech configuration, native-chat page cursor, and per-request
collection ceiling. Session subscription events are also bound to the
requested workspace. Existing Source Control, provider-review, file, and
Markdown correlation remains in force.

The production package now verifies as `3c0f364f…`: 50 assets, 9,135,273 raw
bytes, and 2,644,558 gzip bytes. The full mobile suite passes 589 files / 3,511
tests with 2 expected skips. All project typechecks; root, mobile, and
mobile-web lint; all 56 reliability gates; localization; max-lines; formatting;
and package verification pass. The latest full root run passes 3,854 files /
40,508 tests with 71 expected skips.

The mirrored native package-store suites now pass 120 concurrent cache flows per
platform. The expanded same-host matrix covers competing distinct generations,
live-session activation and cleanup with post-activation reads, interleaved
commit/abort mutations, bounded final retention, and host removal.

Packaging and independent package verification now share one executable policy
that rejects runtime code generation and page-owned Web Storage, IndexedDB,
CacheStorage, cookie, WebSQL, and origin-private filesystem/storage access. It
permits inert storage keywords required by the production syntax highlighter
and rejects build-machine user paths, telemetry SDK/domain markers,
test-fixture environment markers, and native credential-authority
implementations. Hosted URL construction cannot accept a paired-host identity.
Browser state removes credentials and host-local file paths before entering the
page, and hosted navigation rejects credential-bearing URLs. Native transport
and shared-route logging removes endpoint, WebSocket/auth event, repository,
identifier, custom error name, RPC code, and raw error values. The hosted Metro
graph aliases native client and host-store modules to inert implementations by
exact resolved path; the unchanged UI remains while token storage, pairing
cleanup, and logical-client authority leave the package. Focused tests and exact
build `8f452c7b…` verification pass. The remaining security work below is exact
release-app corpus testing, broader live cross-scope races, sustained allocation
testing, and independent review.

A focused final-package iPhone 17 Pro / iOS 26.5 Simulator run now separates
WebView isolation from unrelated native picker automation. The actual WKWebView
passes network, navigation, popup, service-worker, download, external-scheme,
and unmanifested-script isolation. Its private URL has no credentials or query;
the 11,668-byte live DOM and History state contain zero privileged marker; Local
Storage, Session Storage, and cookies are empty. A 12,238,623-byte, ten-minute
Orca unified-log slice contains zero privileged-field, token-storage,
native-authority, private-origin URL, WebSocket URL, or fixture marker.

The exact Pixel 9 Pro API 36 arm64 Debug app now passes the equivalent Android
live privacy and process-exit audit. Its 11,459-byte private-origin workspace
document has no credential or query, no DOM/History marker, no accessible Local
Storage, no Session Storage entry, and no cookie. Network, navigation, popup,
service-worker, download, external-scheme, and undeclared-script probes fail
closed with zero sentinel observation. A 975,464-byte fresh `logcat` slice has
zero privileged-field, token-storage, native-authority, private-origin URL,
unexpected WebSocket URL, or fixture marker. The two observed WebSocket
messages match exact Debug-client and deliberate loopback-probe shapes; mutated
forms fail focused tests. Android reports no new crash, native crash, ANR,
initialization failure, or excessive-resource exit record during the run.

The same simulator now passes a fresh automatic rollback drill without
reinstalling the native shell or editing cache metadata. The paired Desktop
delivered UI-identical candidate `4efe928e…` over final package `8f452c7b…`;
native activation recorded candidate as active and final as previous. Killing
WebContent PIDs `34182`, `34554`, and `34644` mounted four distinct WebKit
targets and atomically restored final in 14.3 seconds. The private origin
changed, the recovered 10,447-byte DOM/history, Web Storage, and cookies contain
zero credential marker, and the 7,156,093-byte Orca log slice contains zero
privileged-field, token-storage, native-authority, private-origin URL, WebSocket
URL, or fixture marker. Physical-device and final release-candidate rollback
remain open.

## 1. Production Release Promotion

- [ ] Promote the exact hybrid-only mobile candidate and matching Desktop
      release streams after the security, device, performance, rollback, and
      App Store gates pass. Candidate testing uses dedicated Desktop RC and
      TestFlight/internal mobile channels, not an in-app architecture switch.

## 2. Automated Integration Gates

- [ ] Run packaged Desktop delivery on macOS, Windows, Linux, and headless
      runtimes.

## 3. Security Gates

- [ ] Run the deterministic filename, diff, terminal-link, provider/task,
      bounded-error, HTML, SVG, Markdown, and Mermaid corpus through the exact
      release app on both platforms and complete independent live interaction
      testing. Disposable hostile filename and diff fixtures now pass through
      Source Control, Session diff, and Review in the exact cached iOS
      Simulator app and Android Debug emulator app. Both platforms render the
      payloads literally, create no injected image, leave execution sentinels
      unset, and retain network/navigation/executable and privacy isolation.
      Both exact apps now also traverse hostile repository Markdown, HTML, and
      SVG through Files/Preview. Markdown preview/source and HTML/SVG source
      stay inert, create no injected element, leave all execution markers
      unset, and make zero sentinel requests. Both exact apps also decode a
      valid 1×1 PNG carrying hostile `tEXt` metadata through the RNW image
      surface without exposing metadata, executing its marker, or reaching the
      sentinel. Both exact apps also pass the same hostile OSC-8 terminal
      corpus: JavaScript links stay inert, no untapped HTTP request reaches the
      sentinel, and a native tap opens the allowlisted repository file through
      the unchanged Session UI. The exact Android Debug app now also passes
      hostile Tasks provider title/body, a bounded hostile provider error, and
      normal/malicious/invalid Mermaid without an executable marker, escaped
      request, bridge-log finding, or new process-exit finding. The emulator
      corpus is complete; store-signed release apps, physical devices, and
      independent interaction review remain open.
- [ ] Fuzz manifests, chunks, paths, MIME types, CSP, cache metadata, bridge
      envelopes, limits, ordering, cancellation, and subscriptions. The
      ten-case TypeScript/Swift/Kotlin quoted/Boolean numeric manifest corpus
      passes after removing Android `JSONObject.optInt` string coercion and iOS
      `NSNumber`/`CFBoolean` integer bridging. Chunk base64 is capped at 65,536
      characters in the shared schema and both native stores before decode; its
      bounded request/chunk mutation corpus passes. Native activation metadata
      accepts only exact `active` and optional distinct `previous` string
      hashes. Its mirrored missing/null/Boolean/numeric/array/uppercase/
      duplicate/unknown/trailing-token corpus fails with the same stable error
      on both platforms. Both native stores cap each raw manifest at 256 KiB
      before JSON parsing. Android now requires the exact root document URL and rejects
      percent-encoded or query-bearing asset requests. One document-CSP contract
      now drives packaging/verification and exact native source parity.
      Manifest and package RPC reuse one exact path predicate, and the same
      18-case path corpus passes in TypeScript, Swift, and Kotlin. All shared
      hash, Git object, bridge/session ID, domain token, and base64 schemas also
      require exact full-string matches; native Swift/Kotlin SHA corpora pass. A
      shared extension/MIME/role map now has exact native source parity and
      mirrored valid/mutated coverage. Persisted primary/canonical manifests,
      activation metadata, and assets now use bounded `limit + 1` readers on
      both platforms, with mirrored oversized-file faults and stable errors.
      Every cache read also rejects outside-root files, file or ancestor
      symlinks, directories, and missing files before opening bytes. A fresh
      exact-JSON preflight also rejects duplicate decoded keys, trailing
      tokens, malformed scalars, and more than 32 nesting levels across primary
      manifests, canonical manifests, and activation metadata. Native cleanup
      faults now reject direct, nested, host-subtree, generation, and dangling
      symlink traversal without touching external sentinels; Android quota
      accounting ignores linked external bytes. Staged-asset and activation
      writes also reject linked parents, while atomic activation replacement
      preserves an external file behind an in-cache link. Exact JSON now rejects
      unpaired Unicode surrogate escapes and has explicit depth-edge coverage.
      Raw bridge JSON now rejects duplicate decoded keys, trailing content,
      unpaired surrogates, and excess depth, including during initial shell
      setup. All 224 production grants reject eight malformed payload shapes
      and an oversized request before authority access. The exported result and
      subscription event schemas reject a generated valid-envelope payload
      corpus and retire invalid events. Pending subscription
      cancellation/client replacement/disposal races pass. Mirrored Swift and
      Kotlin stores pass 120 concurrent cache flows, including same-host
      generation, activation/cleanup, commit/abort, and removal mutations. A
      fresh exact-app rerun and the other listed boundaries remain.
      The page-side semantic corpus rejects 25 schema-valid cross-operation
      identity, action, cursor, and request-specific-limit mutations.
- [ ] Attempt cross-host, cross-build, cross-workspace, cross-session, replay,
      reconnect, process-loss, and host-removal races. Focused tests now reject
      a 15-pair stale session/build grid, retain replay protection across
      authenticated client replacement, revoke opaque workspace authority, and
      prevent late terminal subscription registration after cancellation,
      replacement, or disposal. Deterministic preflight races now cover file,
      Markdown, Source Control, provider review, task, native-chat, workspace
      creation, browser, and Agent History mutations. Broader live mutation and
      exact-app lifecycle races remain.
- [ ] Verify no credential or privileged host identity reaches URLs, DOM state,
      page storage, cache assets, logs, diagnostics, analytics, or fixtures.
      Executable access to browser-owned persistence now fails during both
      packaging and verification. Hosted routes use a fixed page-host label, the
      package rejects build-machine paths, browser state removes credential and
      host-local file URLs, hosted navigation rejects credential-bearing URLs,
      and reviewed mobile logs retain only fixed protocol/state/category fields
      plus numeric or Boolean measurements. Initial and subsequent bridge
      messages reject credential and host-identity fields. Native cache keys
      hash paired identity; activation metadata and session responses contain
      only reviewed hashes, IDs, and private-origin URLs. Hosted package
      resolution removes native token storage, pairing cleanup, and logical
      transport authority. Package policy rejects telemetry SDK/domain and
      fixture-environment markers. Exact-app iOS and Android DOM, History,
      page-storage, cookie, native-log, and process-exit inspection now passes.
      Exact release-app corpus, broader live race, sustained-allocation, and
      independent review remain.
- [ ] Verify all resource limits apply before allocation and during assembly.
      Persisted native manifests, activation metadata, and assets have
      pre-allocation read ceilings; every bridge operation has generated
      malformed-payload and request-limit coverage. Page-side result admission
      repeats request-specific collection and chunk limits. Sustained
      allocation fuzzing remains.
- [x] Complete an independent threat-model and adversarial review. The
      2026-08-21 OpenCode review covered the bridge, native shells, package
      store, runtime RPC, Relay, and SSH boundaries.
- [x] Resolve every high-severity security finding. Bounded SSH/Relay methods
      are wired end to end, file-watch teardown is connection-owned, and common
      credential query forms are redacted, with focused regression tests.

## 4. Device, Topology, Accessibility, and Performance Gates

- [ ] Test low-memory and current physical iPhone and Android phones.
- [ ] Test supported iPad and Android tablet layouts.
- [ ] Test Direct, realistic cloud Relay, native, folder workspace, SSH, WSL,
      reconnect, endpoint change, and two differently versioned desktops.
- [ ] Test software and hardware keyboards, IME, dictation, gestures,
      VoiceOver, TalkBack, Dynamic Type/zoom, and reduced motion.
- [ ] Compare cached entry, terminal input/output, large diffs, memory, battery,
      thermals, and lifecycle behavior against the current native app.
- [ ] Pass a 30-minute sustained-use run and repeated
      host/session/terminal/diff lifecycle loops without progressive
      degradation.
- [ ] Record the device, topology, accessibility, and benchmark artifacts.

## 5. App Store and Final Release Gates

- [ ] Provision an internet-accessible review Desktop with durable credentials,
      representative data, a sample QR code, and exact pairing instructions.
- [ ] Prepare accurate App Review notes covering the desktop-served workspace UI
      and meaningful native features.
- [ ] Submit a production-shaped build through App Review; TestFlight does not
      complete this gate.
- [ ] Record reviewer questions, requested changes, and the final disposition.
- [ ] Obtain acceptance before promoting the hybrid-only candidate.
- [ ] Drill automatic rollback, manual previous-generation recovery, cache
      clearing, corruption, incompatible bridge, disconnection, pairing
      removal, and WebView loss on the final release candidate. The exact
      UI-identical iOS Simulator candidate-to-final three-crash drill passes;
      this item remains open for physical and final release-candidate evidence.
- [ ] Run final CI, packaged release builds, signing, and store-build
      verification.
- [ ] Attach parity, tests, device benchmarks, security review, App Review,
      rollback, screenshots, and final release evidence to the PR.

## Merge Definition

- [ ] Every item above is complete or explicitly removed by an approved design
      change.
- [ ] The final code, design, parity inventory, and release evidence describe
      the same architecture.
- [ ] The production App Store, security, physical-device, performance,
      rollback, CI, and packaged-build gates all pass.
