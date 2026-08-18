# Remote Browser Client Hosting

Status: Proposed

## Decision

Desktop clients should render remote-workspace browser tabs in a local Electron
`<webview>` and route that webview's network traffic through the selected
execution environment.

The runtime authority remains authoritative for logical page identity,
session-tab state, agent commands, and browser-host ownership. The authority is
the paired runtime for a paired environment and the local runtime service for a
locally managed SSH or WSL host. The desktop client leases the browser engine
for each client-hosted page. A page is never silently moved between a client
browser and a server browser because their cookies, storage, certificates, and
transient DOM state can differ.

When a runtime-side browser backend is enabled, server-hosted browsers and
`browser.screencast` remain supported for:

- headless automation with no desktop browser host;
- mobile or web clients when no client-hosted page is available;
- explicit server-browser use cases;
- compatibility with older clients and runtimes.

The current JPEG screencast path is a fallback, not the default desktop path.

A pre-migration Stage 0 compatibility fix (see Rollout) hardens today's
server-hosted headed-Electron creation path for mixed-version deployments. It
does not change this decision: eligible desktop clients request explicit
client placement using their own browser-host lease, and normal desktop
browsing must not depend on a remote `BrowserWindow`, remote renderer IPC, a
server `<webview>`, or the JPEG screencast. Client hosting is never
implemented as "just open a local webview": without the authenticated
execution-host tunnel, remote DNS, route-scoped partitions, and fail-closed
handling described below, a local webview would misroute `localhost` and
private-network traffic to the desktop machine.

## Headless `orca serve`

This architecture supports a headless `orca serve`. A client-hosted page
requires the server to provide only:

- the logical page and browser-host lease control plane;
- the authenticated browser network tunnel;
- execution-host TCP routing.

It does not require a server `BrowserWindow`, display server, Xvfb, GPU, or
offscreen `WebContents`. The browser engine and all rendering live in the
connected desktop client.

Headless and browserless are separate deployment choices:

- A headless server may keep the existing offscreen browser backend for
  unattended agent automation, mobile without a connected desktop, and
  explicit runtime placement.
- A browserless server omits that backend. It can still serve client-hosted
  desktop pages, but browser commands that have no live client host return
  `browser_host_unavailable`.
- A future dedicated browser worker can implement the same browser-host
  command contract if unattended automation is required without shipping a
  browser engine in the core server.

Capabilities remain independent. A browserless server may advertise
`browser.clientHost.v1` and `network.browserTunnel.v1` without advertising
`browser.screencast.v1`. The runtime must never advertise screencast support
merely because a client-host lease could become available later.

## Problem

The current remote desktop browser sends user input to a server-hosted
`WebContents`, captures the result as JPEG frames, and sends those frames back
to the desktop.

This makes ordinary browser interaction depend on several latency-amplifying
stages:

1. Pointer and keyboard actions cross runtime request/response RPC.
2. Compound actions serialize multiple RPCs. A click can require
   `mouseMove`, `mouseDown`, another `mouseMove`, and `mouseUp`.
3. Chromium captures a full viewport image even when only a small region
   changed.
4. CDP base64-encodes the image; main decodes and copies it.
5. The encrypted WebSocket, Electron IPC, renderer Blob, image decode, and
   React state paths add more buffering and work.
6. Queued media frames become stale but can still consume bandwidth before
   backpressure stops capture.

Dedicated screencast sockets prevent browser frames from blocking unrelated
control traffic, but they do not remove the pixel-remoting cost or the
round-trip dependency of input.

## Current Failure and Coverage Gap

### Confirmed headed-Electron failure

Clicking an HTTP link in a paired remote terminal fails when the remote host
is a full headed Electron app rather than a headless server. The client shows
“Unable to open URL”, and the terminal multiplex transport reconnects even
though the PTY and the host process both survive. The terminal appears to
drop and recover while the browser tab never opens.

The headed server-hosted creation path is longer than the headless one:

1. `browser.tabCreate` arrives at the host main process.
2. Main sends `browser:requestTabCreate` to the host renderer.
3. The host renderer runs `createBrowserTab`.
4. The renderer registers the `<webview>`.
5. The host publishes the authoritative session tab.
6. Paired clients reconcile the published session tab.

Every stage after main depends on a live, unthrottled host renderer. A hidden
or backgrounded host window can stall the renderer between the IPC request
and publication; a renderer that authorizes the request against the global
`activeRuntimeEnvironmentId` rejects creation originated by a non-active
runtime session; and a dropped `targetGroupId` misplaces the tab. Each breaks
the chain after the runtime has already committed to the tab, leaving the
runtime and the host renderer disagreeing about whether the tab exists.

### Coverage gap in PR #14194

PR #14194 validates remote link routing against a headless `orca --serve`
host, which creates tabs through `OffscreenBrowserBackend` in the host main
process. That path never touches `browser:requestTabCreate`, the host
renderer, `<webview>` registration, or renderer-driven session-tab
publication. It therefore does not validate the actually affected topology: a
link clicked in a paired remote terminal with a full Electron app acting as
the remote host. The headed path above remains untested end to end, and the
observed failure reproduces only there. Stage 0 in the Rollout section and
the headed-host scenario in the Test Plan close this gap.

## Goals

- Local-feeling pointer, keyboard, scrolling, selection, clipboard, focus, and
  accessibility behavior on desktop remote workspaces.
- Preserve the remote environment's network perspective, including remote
  `localhost`, DNS, private services, redirects, and WebSockets.
- Keep one runtime-authoritative logical page model for desktop UI, agents,
  CLI commands, session restore, and mobile.
- Support paired Orca servers, SSH hosts, WSL, git worktrees, and folder
  workspaces.
- Isolate cookies, storage, permissions, cache, proxy state, and certificates
  between runtime authorities, execution hosts, Orca profiles, and browser
  session profiles.
- Fail closed on tunnel loss; never fall back to the desktop machine's
  `localhost` or network without an explicit placement change.
- Keep the existing server-hosted browser available where client hosting is
  unavailable or unsuitable and the runtime-side backend is enabled.

## Non-goals

- Transparent migration of a live page between client-hosted and
  server-hosted browser engines.
- Synchronizing cookies, IndexedDB, service workers, in-memory DOM state, or
  TLS trust stores between browser engines.
- Replacing the mobile browser experience in the first rollout.
- Supporting SOCKS `BIND`, UDP association, QUIC tunneling, or arbitrary UDP in
  the first tunnel protocol.
- Turning the browser tunnel into a general user-configurable VPN.
- Removing `browser.screencast.v1` during this migration.

## Alternatives Considered

### Tune the JPEG screencast

Latest-frame-wins buffering, lower capture settings, and a smaller renderer
surface would improve the fallback. They cannot make desktop input local or
avoid continuously encoding unchanged pixels. Keep only bounded-media safety
work in that path.

### Replace JPEG with WebRTC video

WebRTC would provide a better server-browser media path through inter-frame
compression and congestion control. It still makes desktop interaction depend
on a remote browser engine, requires signaling and relay traversal, and keeps
local accessibility, clipboard, text input, and native browser behavior behind
a remote-control abstraction. It remains a valid future improvement for
server-hosted pages and mobile viewing, not the preferred desktop architecture.

### Rewrite only remote loopback URLs

Mapping `localhost:<port>` to a reachable host works for simple private-network
setups. It does not cover private DNS, subresources, redirects back to
loopback, arbitrary ports, authenticated relays, or hosts behind NAT. The
network route must operate below URL navigation.

## Architecture

```text
Runtime authority                                   Desktop client

logical browser page
session-tab state
agent / CLI routing       browser-host control      BrowserHostRegistry
        │              ◄──────────────────────────►        │
        │                                                   │
        │                                            local Electron webview
        │                                                   │
        │                                            route/profile-scoped
        │                                            Electron session
        │                                                   │
execution-host connector   browser network route    loopback SOCKS5 proxy
        ◄───────────────────────────────────────────────────┘
        │
remote localhost / private network / public internet
```

There are three separate concepts:

1. **Logical page**: runtime-owned identity and persisted session-tab state.
2. **Browser placement**: the process currently hosting the browser engine.
3. **Interaction owner**: the desktop user, mobile client, or automation
   session currently allowed to mutate the page through input.

Placement and interaction ownership must not be represented by the same enum.
The existing browser driver state is an interaction-presence lock; it is not a
browser-placement contract.

## Logical Page Model

Add a runtime-owned placement record:

```ts
type RuntimeBrowserPlacement =
  | { kind: 'server' }
  | {
      kind: 'client'
      browserHostClientId: string
      browserHostGeneration: number
      pageHostGeneration: number
    }
```

`server` means an authority-managed browser backend, not necessarily an
in-process `WebContents`. The current headless implementation is the runtime
offscreen backend; a headed host additionally has the renderer-hosted
`<webview>` path hardened by Stage 0, which is retired as client hosting
rolls out. A future dedicated browser worker may register behind that same
placement contract without becoming a desktop client lease.

The logical page record continues to carry its stable `browserPageId`,
worktree/folder-workspace scope, URL, title, loading state, and session-tab
identity. It also records whether the last main-frame navigation is safely
restorable without replaying a request body. Sensitive request bodies are never
persisted.

`browserPageId` is unique only within its runtime authority. Desktop main,
renderer, persistence, mirror, and command registries key pages by
`{ authorityId, browserPageId }`; they never use a bare page ID across paired
environments.

The runtime creates every page ID before a browser engine is created:

1. The desktop attaches a browser-host lease for one runtime environment.
2. The desktop requests `browser.tabCreate` with
   `placement: { kind: 'client', browserHostClientId }`.
3. The runtime allocates the logical page and selects the exact live lease.
4. The runtime increments `pageHostGeneration` and emits `CreatePage` to that
   lease.
5. Main derives the approved partition, binds its stable proxy listener, applies
   session policy, and confirms the authenticated route is ready.
6. Renderer creates an `about:blank` webview with no target URL, registers its
   exact `WebContents` and generation with main, and only then receives
   permission to navigate.
7. The desktop acknowledges creation.
8. The runtime returns the page ID only after the host acknowledges creation.

Restored tabs, popups, and profile switches follow the same ordering. No
`src`, `loadURL`, speculative preconnect, or service worker may issue a request
before the partition proxy and page generation are registered. Persisted
workers are stopped or held during session startup until proxy application and
route authorization complete.

If host creation fails or times out, the runtime rolls back the uncommitted
logical page and sends `ClosePage` best-effort in case the acknowledgement was
lost.

Server-hosted creation keeps the current offscreen backend and uses
`placement: { kind: 'server' }`. A runtime without that backend rejects server
placement without affecting client placement.

Host selection is never “first connected client.” A desktop-originated create
names its own lease. Agent, CLI, mobile, or restored-session creation uses an
explicit host selector or the already bound host for that logical browser
session. If multiple eligible clients exist and no policy selects one, the
runtime returns `browser_host_ambiguous`; it does not expose the page to an
arbitrary paired device.

Older callers that omit placement keep current behavior. Updated desktop
clients request client placement only when the runtime advertises all required
capabilities.

The live lease fields are not durable session state. Persistence stores the
logical page, last committed metadata, browser profile, execution-host
identity, and preferred placement. It never persists a connection ID, lease
generation, or live `WebContents` identity as reusable authority. Each runtime
start creates a new authority epoch; every host and page generation is scoped
to that epoch.

## Browser Host Lease

Each desktop process creates a random `browserHostClientId` for its lifetime.
It opens one dedicated `browser.clientHost.attach` subscription per paired
runtime environment. A local runtime authority uses the same protocol over
Electron IPC rather than opening a loopback runtime socket.

The lease is authenticated by the existing runtime pairing or SSH connection.
The runtime binds it to:

- runtime connection identity;
- device token or SSH connection;
- `browserHostClientId`;
- monotonic host generation;
- advertised browser-host capabilities.

The control subscription carries commands and results:

```text
Runtime -> desktop
  CreatePage
  RestorePage
  ReclaimPage
  FencePage
  ClosePage
  CancelCommand
  GrantPopupReservations
  Navigate
  GoBack
  GoForward
  Reload
  Evaluate
  CaptureScreenshot
  DispatchAutomationInput
  SetViewport
  ReadPageState

Desktop -> runtime
  HostedPageInventory
  CommandResult
  PopupReservationCommitted
  NavigationStarted
  NavigationCommitted
  LoadingChanged
  TitleChanged
  FaviconChanged
  DialogOpened
  DialogClosed
  PageSuspended
  PageCrashed
  PageClosed
  HostResourcePressure
  HostHeartbeat
```

Every command includes `browserPageId`, browser-host generation, page-host
generation, authority epoch, monotonic per-page command sequence, and command
ID. Results are accepted only from the lease, epoch, and both generations that
currently own the page. The host generation fences a replaced desktop lease;
the page generation fences a destroyed and recreated `WebContents`. Late
results from any older fence are dropped.

Agent and CLI browser methods keep their current public names. Runtime routing
changes internally:

- server placement delegates to the existing browser backend;
- client placement sends a host command and awaits its result;
- missing client lease returns `browser_host_unavailable`;
- no method silently creates a server-hosted replacement page.

Local user input goes directly to the Electron webview and never crosses the
runtime control subscription. Agent and mobile synthetic input still routes
through the runtime so authorization and ownership remain centralized.

Desktop browser chrome follows the same local path for client placement.
Address-bar navigation, back, forward, reload, stop, focus, zoom, and find
execute against the fenced local `WebContents` after checking interaction
ownership, then publish resulting page events to the runtime. They do not add a
runtime round trip before acting. Server placement and non-hosting clients keep
using runtime commands.

### Reconciliation and command delivery

Attach and reconnect begin with an inventory exchange. The client reports each
hosted page ID, page generation, browser profile, execution host, and current
URL. The runtime replies with the desired page set and current generations:

- orphaned client pages are fenced, destroyed, and denied tunnel access;
- runtime pages missing on the client are restored only after a new generation
  is allocated;
- matching pages from the current authority epoch are reclaimed without
  navigation;
- profile, execution-host, placement, or generation mismatches are never
  adopted.

This makes a lost create acknowledgement, renderer reload, runtime restart, and
client crash converge without relying on best-effort close messages.

After an authority restart, an old-epoch webview may preserve its DOM only when
the new runtime finds the exact persisted logical page, authenticates the same
client host, verifies the partition binding and execution host, and issues
`ReclaimPage` with a new epoch and page generation. The client pauses input and
network until that command arrives. This is explicit reauthorization, not
reuse of an old generation; every other old-epoch page is destroyed.

Command sequence provides admission deduplication within one page generation;
an already admitted or older sequence is never applied again even after its
cached result expires. A bounded result cache may replay a completed result for
the same command ID. If the result has expired, the duplicate fails as
`browser_command_result_expired` rather than executing again. Mutating commands
such as click, type, evaluate, upload, and navigation are not automatically
retried after disconnect or timeout. If the host may have applied one without
returning its result, the runtime returns `browser_command_outcome_unknown`.
Read-only methods may retry only while all fences still match.

Mutating commands execute FIFO per page generation. Read-only commands run
concurrently only when their API contract permits observing the same state;
otherwise they join the page queue. Separate pages may execute in parallel.
Command result arrival order never substitutes for command ID and page event
revision checks.

Cancellation and timeout stop pending work where Chromium supports it, but do
not pretend to undo page side effects. JSON control results are size-bounded.
Screenshots, PDFs, large snapshots, and mirror frames use dedicated bounded
binary transfers so a large result cannot starve lease revocation,
heartbeats, dialogs, or navigation events.

Page events carry a monotonically increasing event revision within their page
generation. The runtime ignores duplicates and revisions older than the last
accepted event. A terminal close or crash event wins over later URL, loading,
title, favicon, and dialog events from that generation.

### Interaction ownership

Direct desktop input is local, but it is not unconditional. The host maintains
the runtime-issued interaction-owner generation and enables guest pointer,
keyboard, drag, clipboard, and focus input only when that generation grants the
desktop control. Losing ownership immediately blurs the guest, releases pointer
capture, cancels IME composition, and blocks new local input before takeover is
acknowledged.

Mobile and agent input commands carry the same owner generation and are
rejected by the client host if it is stale. Lease revocation or explicit
takeover first fences input and network access on the old host, then creates the
new page generation. A timed-out old host may retain pixels in memory, but it
cannot continue reaching the execution host or publish authoritative page
events.

An automation session that performs mutating commands acquires interaction
ownership for the relevant command or declared sequence. While it owns the
page, direct desktop input is visibly locked; the user can explicitly take
control, which cancels pending automation before issuing a new owner
generation. Read-only inspection does not take input ownership.

## Desktop Browser Registries

Use separate main and renderer registries instead of placing DOM ownership in
main or transport ownership in React.

The main browser-host registry owns:

- the authority/page key to `WebContents` mapping;
- the route- and profile-scoped Electron session;
- command execution from the host lease;
- browser event listeners and runtime event publication;
- teardown on page close, environment removal, or lease replacement.

The renderer client-browser registry owns:

- the authority/page key to `<webview>` element mapping;
- attachment to the visible pane placeholder;
- hidden-page retention and bounded LRU eviction;
- registration of each current `WebContents` ID with main;
- DOM teardown after main has fenced the page generation.

React panes attach and detach a registry-owned webview. Switching panes must
not destroy and recreate the browser engine. Hidden-page retention is bounded;
an evicted page is reported to the runtime as suspended and its page-host
generation is closed. Before the next visible attach or agent command, the
runtime increments the page-host generation, sends `RestorePage` with the last
committed URL, and waits for its acknowledgement. No command is delivered to a
missing or older `WebContents`. Restoration is shown as a reload and is not
presented as preservation of transient DOM state.

A page whose last main-frame state depends on POST, upload, authentication
challenge, or another non-idempotent request is not automatically restored from
its URL. It is protected from ordinary discard; forced recovery opens a clear
resubmission choice or a blank page and never persists or replays the request
body.

Discard is not allowed while a page has an in-flight command, download,
upload, dialog, permission prompt, active media capture, DevTools attachment,
mobile mirror, or a known `beforeunload` guard. A memory-pressure discard may
still lose undetectable form or in-memory application state, so the page is
visibly marked as discarded and never described as suspended without data
loss. The active page is never selected by ordinary LRU eviction.

User-initiated close is a host handshake rather than immediate logical-record
deletion. If Chromium prevents unload, the hosting desktop presents the native
confirmation and reports close cancellation or completion to the runtime. CLI,
mobile, and shutdown callers must choose normal close or an explicitly
authorized forced close. A page crash closes only the page generation, retains
the logical page and last committed URL, and offers restore.

One live webview can attach to only one pane container. If two windows or split
panes reference the same logical page, one receives the interactive surface and
the other receives a non-interactive mirror or an “Open here” takeover
placeholder. Reparenting a `<webview>` is not used as a display operation
because Electron may recreate its guest.

The browser-host lease is viable only while a renderer capable of retaining
the registry exists. Renderer crash, window destruction, application relaunch,
and closing the last hosting window trigger reconciliation and suspend or close
the affected page generations. A future main-owned `WebContentsView` may relax
that constraint without changing the host protocol.

Hidden pages need an explicit background policy. Agent commands, downloads,
audio, timers, and mobile mirroring must not accidentally change behavior only
because the pane is hidden. The implementation either disables background
throttling for protected pages or reports a page as suspended before Chromium
throttles it beyond the browser command contract.

Electron proxy configuration is session-wide, so the partition key must
identify every boundary that can change either browser storage or network
egress:

```text
persist:orca-browser:<orca-profile-hash>:<browser-profile-hash>:<authority-hash>:<execution-host-hash>
```

The browser profile component distinguishes the default and every named browser
session profile. The authority and execution-host components distinguish, for
example, the paired server from an SSH target reached through that server. Two
pages may share a partition only when all four identities match.

Raw runtime IDs, target IDs, hostnames, usernames, and paths must not appear in
the partition string. Hashing prevents invalid partition characters and avoids
exposing infrastructure names in Chromium storage paths. Hash inputs use stable
canonical IDs, not mutable display names. The derivation is versioned,
delimiter-safe, and identical on macOS, Linux, and Windows. Stored binding
metadata is checked before reuse so a derivation bug or collision fails closed
instead of sharing storage or proxy state.

The authority and execution-host inputs include non-reusable local record
identity, not only a server-reported runtime ID, hostname, distro name, or SSH
alias that may later be recycled. Delete-and-readd creates a new storage scope
unless the user explicitly adopts the old browser data after identity
verification.

A partition is permanently bound to one execution-host identity. Reconnect may
replace its route generation, but code must never call `setProxy` to retarget
the partition to another host. Moving a workspace, changing an SSH target, or
changing browser profile creates a new browser engine and partition.

Main derives and registers the partition, applies its policies and proxy, and
then gives renderer an opaque approved partition name for the exact page
generation. Renderer input never chooses or constructs a partition. The
existing `will-attach-webview` boundary rejects derived partitions that are not
live in this registry.

Deleting a browser profile or execution environment first fences and closes
every page using its partitions, waits for downloads and transfers to resolve
or cancel, removes session policies, and then clears storage. A stale renderer
cannot recreate a deleted partition from persisted tab data.

## Remote Network Route

The local webview uses a loopback SOCKS5 proxy owned by the Electron main
process. The proxy supports SOCKS5 `CONNECT` with domain names, IPv4, and IPv6.
It rejects `BIND`, UDP association, and non-loopback peers.

The Electron session uses fixed proxy rules for all HTTP, HTTPS, and WebSocket
traffic. The implementation must explicitly defeat Chromium's implicit
loopback bypass so `localhost`, `127.0.0.1`, and `::1` reach the selected
environment instead of the desktop. It must cover Chromium's complete loopback
classification, including `.localhost`, a trailing-dot hostname, the full
`127.0.0.0/8` range, IPv4-mapped IPv6, and accepted numeric IPv4 spellings;
enumerating only three literal hosts is insufficient.

DNS names are sent through SOCKS as names and resolved by the remote
environment. Resolution occurs at the final selected execution host, not the
desktop, paired runtime authority, SSH jump host, or Windows side of a WSL
route. Intermediate adapters must not pre-resolve them. The remote connector
normalizes every socket target intended as a listener, including redirects,
popups, and subresources:

- `0.0.0.0` becomes remote `127.0.0.1`;
- `[::]` becomes remote `::1`;
- ordinary loopback addresses remain loopback on the remote environment.

All browser traffic uses the remote route, including public internet traffic.
Selective direct routing would change origin IP, DNS, authentication, and
network policy within one page.

One loopback listener is scoped to
`{ browserHostClientId, authorityConnectionIdentity, executionHostId }`.
The authority connection identity includes the Orca profile and pairing/SSH
credential boundary, not only the runtime's public ID. Multiple browser profile
partitions may share the listener because their network egress is identical;
storage remains separate. Its lifetime is reference-counted across those
partitions. A reconnect swaps the listener's upstream route generation without
changing its local address or retargeting any Electron session. While no
authenticated route exists, the listener remains bound but rejects every
`CONNECT`. If a listener must be replaced after an OS-level failure, main
applies the new proxy to every bound session, closes all their connections, and
proves the old listener cannot receive traffic before allowing reload.

Electron network-service or utility-process restart is treated as a route
failure. Main holds page network access, reapplies and verifies fixed proxy
state for every bound session, and closes inherited connection pools before
pages resume. Process recovery may not reset a partition to system or direct
proxy mode.

TCP-only means fail closed, not fall back to the desktop:

- QUIC, HTTP/3, WebTransport over UDP, direct WebRTC candidates, multicast DNS,
  and other UDP paths must be disabled or denied unless a later tunnel version
  carries them.
- HTTP/3 may fall back to HTTP/2 or HTTP/1.1 through SOCKS.
- WebRTC is unavailable in the first version unless tests prove its complete
  media and DNS path uses the remote route; camera or microphone permission
  alone must not enable a direct network path.
- DNS prefetch, speculative preconnect, service workers, shared workers, and
  background fetches use the same partition proxy and may not retry through
  local DNS or a direct socket.
- Client-side secure DNS/DoH is disabled for these partitions unless a real
  Electron test proves the resolver request and final name resolution both
  occur through the selected remote route.

Browser-global services require a separate audit because they may not honor a
guest partition proxy. URL prediction, cloud spellcheck, translation, safe-
browsing lookups, crash uploads, and similar services are disabled for
client-hosted guests unless they are proven not to receive page secrets and
their required network path is explicitly accepted. A page load must not leak
its URL or typed content through the desktop's direct network as “browser
telemetry.”

The execution-host route must also account for required outbound proxy policy.
Direct `net.connect` is not equivalent to a remote browser when the remote host
requires an enterprise HTTP proxy or PAC file. Client placement is ineligible
unless its execution-host adapter can either connect directly or faithfully
apply the required upstream proxy. Unsupported proxy authentication,
integrated authentication, or PAC behavior surfaces a specific route error and
offers explicit runtime placement.

Route selection has two independent inputs:

- the authority transport: paired runtime or local runtime service;
- the execution host: native, SSH, or WSL.

A paired runtime always carries browser network traffic over
`network.browserTunnel`, even when that runtime reaches the final target
through SSH or WSL. A local runtime service can connect directly through its
locally owned SSH or WSL adapter. This preserves the selected execution host's
network perspective without moving credentials between authorities.

### Paired runtime adapter

Add one dedicated `network.browserTunnel` binary subscription per authority
connection and execution-host route. Its attach request binds the exact
execution-host identity, expected host revision, browser-host lease, and route
generation before any `Open` is accepted. It multiplexes remote TCP connections
for only that route and does not share the browser-host control socket. Bulk
page traffic therefore cannot delay automation commands, host heartbeats, or
page lifecycle events.

The protocol has:

- tunnel generation;
- stream ID;
- opcode;
- payload length;
- bounded payload.

Required opcodes:

```text
Open(host, port)
Opened
Data(bytes)
WindowUpdate(bytes)
HalfClose
Close
Error(code)
Ping / Pong
```

The WebSocket is ordered, so per-frame sequence numbers are unnecessary for
live streams. Tunnel generation prevents frames from an old connection from
being applied after reconnect. Stream IDs are never reused within a tunnel
generation. Duplicate opens, frames for unknown streams, credit overflow, and
invalid half-close transitions are protocol errors.

Flow control is credit-based in both directions. Each receiver grants credit
for bytes it is prepared to accept:

- start each stream with a 256 KiB receive window;
- pause the source socket when credit reaches zero;
- replenish credit only after the destination write has drained below its
  bounded high-water mark, not merely after `write()` queued the bytes;
- cap aggregate retained tunnel data at 8 MiB per execution-host route,
  32 MiB per desktop browser host, and a configured process-wide limit on the
  runtime;
- include WebSocket `bufferedAmount`, codec buffers, and pending socket writes
  in retained-byte accounting;
- close only the offending stream on a per-stream overflow;
- terminate and recreate the tunnel on aggregate accounting failure.

These are initial safety bounds, not user settings. Performance evidence may
adjust them without changing protocol semantics.

The adapter also bounds concurrent streams, pending opens, open rate, and
connect duration. It schedules active streams fairly so a download cannot
consume every send opportunity. Per-message compression is disabled for tunnel
data, which is often already compressed and must not create an unaccounted
compression buffer. Ping timeout, WebSocket close, runtime shutdown, and
explicit cancellation close every stream and release its accounting exactly
once. Runtime-wide admission is fair across authenticated browser hosts so one
paired desktop cannot exhaust every route or buffer slot.

For a runtime-native execution host, remote connections use that runtime's
`net.connect`. For an SSH- or WSL-scoped execution host, the runtime dispatches
the open to its matching execution-host adapter instead. Connection errors are
returned as structured tunnel errors without leaking unrelated filesystem or
process details.

### SSH adapter

SSH workspaces use the existing authenticated SSH connection owned by their
runtime authority:

- the `ssh2` provider maps each SOCKS `CONNECT` to an SSH `forwardOut` channel;
- the system-SSH provider owns one managed dynamic-forward process for the
  browser route and performs an internal SOCKS handshake for each requested
  destination;
- reconnect replaces the route generation and closes stale channels;
- target removal and relay shutdown stop the proxy and its SSH resources.

With a local authority, the desktop SOCKS server dispatches directly through
these channels. With a paired authority, their bytes remain inside
`network.browserTunnel` between the desktop and runtime. The browser route
shares SSH authentication and host-key policy with the workspace connection.
It must not launch an independent interactive SSH prompt.

The system-SSH dynamic-forward port is an internal upstream, not the proxy
endpoint stored in an Electron session. Keeping the main-owned listener in
front preserves route fencing, stable partition configuration, normalization,
accounting, and reconnect behavior when the SSH process is replaced.

### WSL and local execution adapters

WSL routes connections through the WSL execution boundary owned by the runtime
authority so WSL loopback means the selected distro, not Windows. A paired
authority still carries those bytes over `network.browserTunnel` before the WSL
hop. Native local execution does not use this remote design and keeps the
existing local browser session.

Route selection is based on execution-host identity, never on whether a
workspace has a `.git` directory. Folder workspaces and git worktrees therefore
use the same browser route.

## Navigation, Storage, and Files

The address bar displays the user-requested URL. Proxy routing must not replace
remote `localhost` with a visible generated URL.

Browser chrome also shows a non-page-controlled execution-host label beside
loopback/private destinations and in permission, certificate, download, upload,
external-protocol, and takeover prompts. Two tabs displaying
`http://localhost` on different hosts must be visibly distinguishable without
changing their origin URL. Any new UI follows `docs/STYLEGUIDE.md` and existing
browser-pane components.

HTML fullscreen, popup windows, picture-in-picture, and DevTools cannot remove
the execution-host/origin escape affordance or place page-controlled content
over a native security prompt.

Browser storage lives on the desktop in the route- and profile-scoped
partition.
Consequences:

- cookies and service workers persist across remote runtime restarts on that
  desktop;
- another desktop does not automatically receive them;
- clearing browser data operates only on the selected route/profile partition;
- agent commands target the same local webview and therefore see the same
  storage as the user.

A named browser profile supplies policy and an identity label; it does not make
one live cookie jar span execution hosts. Cookie import or profile cloning must
name the destination authority/execution-host partition. Initializing a new
partition from a user-approved template is a one-time copy, not ongoing cookie,
service-worker, cache, or credential synchronization.

Service workers and background tasks keep the route alive while they can issue
requests, even if their last visible page closes. Route retention is
reference-counted across pages, workers, downloads, and transfers. Environment
removal and authorization revocation override the reference count and terminate
them.

A worker alone cannot retain a tunnel forever after every logical page and
transfer in its partition is gone. After a bounded idle period, main stops the
partition's workers and releases the route; opening a later page starts them
again through a fresh authenticated generation.

Cache, IndexedDB, service-worker, and other partition disk usage is measured
and exposed with clear-data controls. Cache may follow a bounded eviction
policy, but cookies, credentials, and durable site storage are never silently
deleted merely to satisfy the webview LRU bound.

`window.open`, `target=_blank`, and popup OAuth flows cannot wait for a runtime
round trip because Electron's popup decision is synchronous. The runtime
therefore grants each live host lease a small bounded pool of single-use popup
reservations containing runtime-created page IDs and generation-scoped
capability tokens. Main consumes one synchronously, creates the popup with the
opener's placement, execution host, and browser profile, and commits the
reservation to the runtime. An exhausted pool denies the popup and offers a
retry; it never creates an unregistered guest. An uncommitted or rejected
reservation is fenced and destroyed on timeout.

Reservations cannot be transferred across host, authority, or page
generations. The runtime validates the live opener and derives workspace scope
from it rather than trusting renderer-supplied scope. Opener relationships are
retained only while both pages share the same partition and placement
generation.

Top-level `http`, `https`, `about:blank`, and browser-generated error pages are
supported. `blob:` and `data:` documents may exist only when created by an
already authorized page and inherit its guest boundary. Typed `javascript:`,
`chrome:`, `devtools:`, extension, and other privileged schemes are rejected.
External protocols such as `mailto:` require an explicit desktop confirmation
that names the requesting origin; they are never executed on the remote host by
implication.

Downloads are handled by the desktop browser and save on the desktop. Copy must
state the destination honestly. Uploads and file inputs originate from the
desktop; selecting a remote workspace file requires the existing explicit
remote-file transfer path rather than exposing remote filesystem paths to the
local webview.

Download, upload, and remote-file transfer ownership is explicit during
disconnect, page close, profile deletion, and takeover. A transfer is either
allowed to complete under the original fenced host or cancelled; it is never
silently resumed on another browser engine. Partially downloaded local files
use the existing recoverable download behavior.

`file://` navigation and subresources are blocked for a client-hosted remote
workspace page. A remote file requires an authenticated file-serving URL or
explicit server placement. Opening a desktop-local file is a separate explicit
local-browser action and is never inferred from a remote path.

TLS is terminated by the local browser. Private certificate authorities trusted
only by the remote OS will not automatically be trusted locally. The first
version should surface the certificate error and offer explicit server
placement; silent certificate bypass or trust-store copying is out of scope.

The same local-versus-remote distinction applies to client certificates,
Kerberos/NTLM identity, passkeys, hardware security keys, camera, microphone,
screen capture, geolocation, and notification permission. Client placement uses
the desktop's devices and credential stores under Orca's existing deny-by-
default browser permission policy. When a workflow requires the remote host's
trust store, device, or integrated identity, it requires explicit runtime
placement; the UI must not imply that network routing also moved those local
capabilities.

Web standards may treat `http://localhost` as a secure context, but Orca's
permission policy must also inspect route identity. A remote-routed loopback
origin is not trusted as a desktop-local application and does not inherit any
automatic local-only WebAuthn, HID, media, notification, clipboard, or external
protocol grant based solely on its hostname.

Client placement intentionally has a hybrid browser fingerprint: network IP and
DNS are remote, while Chromium version, operating-system platform, timezone,
locale, fonts, screen metrics, GPU/WebGL, and device APIs are desktop-local.
The first version does not spoof these values. Workflows that require the
runtime host's browser fingerprint use explicit runtime placement.

## Disconnect and Reconnect

Tunnel loss fails closed:

1. Keep the stable loopback listener bound but reject new SOCKS `CONNECT`
   requests.
2. Close active proxied sockets.
3. Keep webviews and their last rendered content alive.
4. Mark the guest network offline where Electron supports it so page
   `offline`/`online` behavior follows tunnel availability.
5. Show the existing remote-disconnected state over the pane.
6. Re-establish the authenticated environment connection and tunnel.
7. Bind the new route generation to the existing listener and allow normal
   page retry/reload.

Orca does not automatically reload a page, replay a navigation, or resubmit a
form after reconnect. It only restores network availability; Chromium's normal
idempotency and resubmission rules remain in force, and the user confirms any
POST resubmission.

The host-control and browser-tunnel sockets have correlated authorization even
though they are physically separate. Lease expiry, pairing revocation, target
removal, or takeover revokes the tunnel route for that host. Control loss
during reconnect grace blocks new local and synthetic input as well as new
network connections; an independently live tunnel is not permission to keep
browsing.

The user may dismiss a pane while the authority is offline, but this records a
revision-guarded pending close intent rather than pretending the logical page
was deleted. Reconciliation resolves that intent before any missing page is
restored, preventing a deliberately closed local pane from unexpectedly
reappearing after reconnect.

The browser-host lease has a short reconnect grace keyed by
`browserHostClientId` and a new generation. During grace, logical pages remain
client-placed but unavailable. A matching client can reattach and reclaim
them. When grace expires, pages remain recorded but commands return
`browser_host_unavailable`.

There is no automatic server placement after disconnect. The UI may offer
`Reopen on server`, which creates a new server-hosted page at the last committed
safe-to-restore URL and clearly states that signed-in and transient page state
may differ. A non-idempotent page opens blank or requires explicit user
resubmission; Orca never reconstructs its request body.

Transient transport loss may retain the last rendered pixels. Explicit sign
out, pairing revocation, profile deletion, environment removal, or a security
policy change destroys the affected webviews and clears in-memory page data
immediately. Persisted partition deletion follows the product's existing data
retention policy and must be an explicit decision, not an accidental side
effect of a network flap.

Sleep/wake and network-interface changes follow the same generation replacement
path. No socket, DNS result, or optimistic connection created before wake is
adopted into the new tunnel generation.

## Multiple Clients and Mobile

One browser engine owns one client-placed page at a time.

A second desktop can:

- observe the logical tab and last committed metadata;
- request an explicit takeover;
- open a separate page;
- consume a mirror stream if the current host supports it.

Takeover invalidates the old lease generation, closes the old hosted page, and
recreates a safely restorable page from its last committed URL on the new host.
It does not claim to transfer live DOM or storage, and it never replays a
non-idempotent request. Takeover is two-phase: the old host is first fenced from
input, events, and network access; only then may the new host acknowledge its
page generation. A timeout may force the fence but cannot skip it.

Mobile compatibility is required before client hosting becomes the default:

- server-placed pages keep the current screencast path;
- client-placed pages can be mirrored only while the hosting desktop is
  connected;
- the desktop captures frames on demand and sends them through the runtime to
  the mobile subscriber;
- mobile synthetic input is forwarded by the runtime to the hosting desktop;
- no mobile subscriber means no client-page capture work.

The mirror stream may initially reuse the bounded JPEG screencast protocol. It
must be latest-frame-wins and is not on the desktop interaction path. A later
video codec change is independent of client hosting. Mirror frames use a
dedicated bounded binary subscription, never the browser-host control channel.

The hosting desktop shows when another client is viewing or controlling its
page. Subscription authorization is rechecked on attach, interaction takeover,
lease change, and reconnect. Unsubscribe, authorization loss, or page close
stops capture before acknowledgement and prevents queued frames from being
delivered afterward.

Desktop OS-session lock and Orca profile lock follow the existing remote-access
policy. Unless that policy explicitly permits unattended client hosting, they
pause mirror capture, synthetic input, and new browser network activity until
the desktop is unlocked. A mobile client is never allowed to bypass a local
lock merely because its previous subscription remains connected.

Mirror metadata includes page generation, capture size, device scale factor,
zoom, and frame sequence. Mobile coordinates are mapped against that exact
frame and rejected when stale. A mobile subscriber does not silently resize the
desktop page; a separate mobile viewport requires a separate browser page.

Page audio, autoplay policy, media devices, and output selection belong to the
hosting desktop. The initial JPEG mirror is visual-only, matching the current
screencast contract. If mobile browser audio becomes a requirement, it uses a
separate authorized media channel with independent backpressure and mute state;
it is not mixed into control or image frames.

## Capability Negotiation

Add narrow runtime capabilities:

```text
browser.clientHost.v1
network.browserTunnel.v1
browser.clientMirror.v1
```

Capability negotiation is two-sided. Runtime status advertises protocol and
route support; the attached client lease advertises its webview, automation,
binary-result, mirror, and platform capabilities. Page creation selects a
specific live lease whose advertised set satisfies the request.

The desktop chooses client placement only when:

- it can host Electron webviews;
- a remote network adapter is available for the execution host;
- the runtime supports client-host commands;
- mobile parity requirements for the rollout stage are satisfied.

Otherwise it requests server placement and uses
`browser.screencast.v1` when both capabilities are available. If neither
placement has a live browser host, page creation returns
`browser_host_unavailable`.

Capability results are cached per execution host and transport identity. An
unsupported response disables only that preferred path for the matching host;
it must not disable client hosting for other paired servers, SSH targets, WSL
distros, or relay connections.

Version changes never migrate a live page. During rolling upgrades, existing
pages continue on the negotiated version until closed or explicitly reopened.
Unknown optional fields are ignored, unknown required features reject attach,
and capability downgrade on reconnect suspends incompatible pages rather than
silently changing placement.

## Security

- The local SOCKS listener binds only to loopback and exists only while its
  execution-host route is retained by at least one approved partition.
- The SOCKS listener uses an OS-assigned port and accepts the SOCKS no-auth
  method only after confirming the peer is loopback. Sibling local processes
  remain inside the desktop host trust boundary; if that threat model changes,
  authenticated local proxy negotiation is a rollout blocker.
- Loopback binding and a random port are not authentication. Security review
  must confirm the existing Orca desktop threat model trusts sibling local
  processes. Otherwise the design must use a Chromium-supported authenticated
  HTTP proxy in front of the route or OS-enforced process isolation; it must not
  treat port secrecy as sufficient.
- Every paired-server tunnel is authenticated and encrypted by the existing
  runtime transport.
- SSH tunnels reuse established SSH identity, host-key verification, jump-host,
  and proxy-command policy.
- A tunnel can connect only from the authenticated runtime process to network
  targets visible to that runtime.
- Tunnel opens are bound to an active host lease, authority epoch, and exact
  execution-host identity; one page cannot name a different SSH target in an
  `Open`.
- Browser partitions are isolated per Orca profile, browser session profile,
  runtime authority, and execution host.
- DNS resolution occurs remotely; failure must not retry through local DNS.
- Unsupported proxy operations fail instead of bypassing the proxy.
- Tunnel payload sizes, stream counts, retained bytes, and open timeouts are
  bounded.
- Page and tunnel commands validate runtime connection, host generation, page
  placement, and workspace scope.
- Logs record stream IDs, sizes, state transitions, and error codes, never page
  bodies, cookies, authorization headers, query secrets, or tunnel payloads.
- Browser traffic must not share the control socket, preventing a large
  download from starving lease revocation or authorization changes.
- Client-hosted guests use sandboxing, context isolation, no Node integration,
  no page-controlled preload, a partition allowlist, and main-process
  validation for every guest registration and popup. Remote content never
  receives Orca renderer IPC or local filesystem access.
- Local browser-chrome IPC validates the authoritative Orca renderer, authority
  key, page generation, and interaction owner; a guest frame cannot invoke host
  commands by forging a page ID.
- Certificate exceptions, permissions, downloads, external-protocol launches,
  and DevTools attachment are scoped to the current page and partition
  generation. A stale page cannot reuse a prompt result.
- Permission checks receive the remote-route identity; remote `localhost`
  cannot satisfy a policy intended only for desktop-local origins.

The threat model should explicitly document that a remote browser already has
the remote environment's network reach. Client hosting preserves that
capability; it does not expand it to unauthenticated clients.

## Observability and Performance Gates

Record per runtime authority and execution host:

- browser-host attach and reclaim duration;
- active proxied stream count;
- tunnel bytes in/out;
- per-stream and aggregate buffered bytes;
- remote connect latency and error code;
- control-command latency for agent operations;
- command timeout and unknown-outcome count;
- reconnect count and grace recovery success;
- page reconciliation, crash, discard, and restore count;
- retained route count and partition disk usage;
- mirror capture-to-present latency when mobile is attached.

Do not log destinations containing userinfo or unredacted query strings.
Hostname and port diagnostics follow the existing network-diagnostic redaction
policy.

Desktop rollout gates:

- local pointer and keyboard events never wait on runtime RPC;
- local address-bar and toolbar actions on a client-hosted page never wait on
  runtime RPC;
- no desktop browser frame stream exists for an active client-hosted page;
- proxy overhead inside Orca is under 10 ms p95 excluding remote network RTT;
- browser-host attach completes under 500 ms p95 on an established runtime
  connection;
- tunnel retained memory stays within its configured bounds during a
  non-reading peer test;
- a 100 Mbps download does not delay host control heartbeats or agent command
  dispatch;
- a large screenshot, PDF, or mirror stream does not delay host control;
- no guest DNS, UDP, TCP, WebRTC, or speculative connection reaches a desktop
  interface outside the selected SOCKS listener;
- disconnect never loads the desktop's own `localhost`.

## Implementation Boundaries

Suggested new modules:

- `src/shared/browser-client-host-protocol.ts`
- `src/shared/browser-network-tunnel-protocol.ts`
- `src/shared/browser-route-identity.ts`
- `src/main/browser/browser-client-host-registry.ts`
- `src/main/browser/browser-route-session-registry.ts`
- `src/main/browser/browser-popup-reservation-pool.ts`
- `src/main/browser/remote-browser-socks-server.ts`
- `src/main/browser/paired-runtime-browser-network-route.ts`
- `src/main/ssh/ssh-browser-network-route.ts`
- `src/main/runtime/browser-host-command-ledger.ts`
- `src/main/runtime/rpc/methods/browser-client-host.ts`
- `src/main/runtime/rpc/methods/browser-network-tunnel.ts`
- `src/renderer/src/components/browser-pane/client-hosted-browser-registry.ts`
- `src/renderer/src/components/browser-pane/ClientHostedBrowserSurface.tsx`

Existing `BrowserPane.tsx` should delegate client-hosted lifecycle and rendering
to the new surface instead of absorbing the proxy, lease, and registry logic.
Do not add a `max-lines` disable or increase a per-file limit.

The shared protocol modules contain only validation and binary
encoding/decoding. Main owns Electron sessions, proxy listeners, socket flow
control, and SSH/runtime routing. Runtime owns logical page placement and
command brokerage. Renderer owns pane attachment and visible state.

The runtime-authority placement, lease, and tunnel modules must not import
Electron or assume a display is present. Electron-specific `WebContents`
ownership stays behind the desktop client-host adapter and the optional
offscreen backend. This keeps a future Node-only `orca serve` process compatible
with the protocol.

## Rollout

### Stage 0: Headed server-hosted compatibility fix (pre-migration)

This stage repairs the current server-hosted headed-Electron creation path
described in Current Failure and Coverage Gap. It is a mixed-version
compatibility fix so existing deployments stop failing while Stages 1–5
land. It is not the intended desktop architecture, and it must not weaken,
delay, or substitute for client hosting. In the target architecture, server
placement uses an authority-managed backend; the headed renderer-hosted
`<webview>` path exists only for compatibility until client hosting rolls
out.

1. Acquire the existing `RendererPublicationThrottle` lease on the host
   renderer during remote browser creation, including when the host window is
   hidden or backgrounded. Hold the lease until renderer creation and
   authoritative session-tab publication complete, so background throttling
   cannot stall the renderer between `browser:requestTabCreate` and
   publication.
2. Mark renderer IPC creation as runtime-session-originated. The renderer
   authorizes the request against the originating runtime session instead of
   using the global `activeRuntimeEnvironmentId` as its authority check; a
   request from a non-active runtime session is not rejected as foreign.
3. Preserve `targetGroupId` through the Electron renderer path so the created
   tab lands in the requested tab group.
4. Make creation transactional. Each stage returns a structured failure —
   `renderer_ipc`, `webview_registration`, `session_tab_publication` — and a
   failed stage rolls back the uncommitted tab instead of leaving the runtime
   and renderer with divergent tab state.
5. Verify that adding a browser tab preserves terminal tabs: no terminal tab
   closes, no terminal pane remounts, and no terminal multiplex subscription
   is closed or recreated as a side effect of browser tab creation.

### Stage 1: Contracts and remote network route

1. Add capability constants and protocol codecs.
2. Implement the loopback SOCKS server with bounded sockets and remote DNS.
3. Implement the paired-runtime TCP tunnel and SSH adapters.
4. Validate HTTP, HTTPS, WebSocket, remote loopback, redirects, and DNS without
   creating client-hosted pages.

### Stage 2: Client-hosted page lifecycle

1. Add runtime placement records and browser-host leases.
2. Add the desktop browser registry and route/profile-scoped partitions.
3. Create, attach, detach, close, navigate, and restore client-hosted pages.
4. Keep server placement as the default while gathering diagnostics.

### Stage 3: Agent and CLI routing

1. Route existing browser methods by placement.
2. Add command IDs, timeouts, cancellation, generation checks, and disconnect
   errors.
3. Verify automation observes the same cookies and DOM as local user
   interaction.

### Stage 4: Mobile compatibility

1. Add on-demand client mirror capture.
2. Forward mobile input to the client host.
3. Cover desktop loss, mobile unsubscribe, takeover, and stale-generation
   races.

### Stage 5: Default and cleanup

1. Enable client placement by default only for newly created eligible remote
   desktop pages; never migrate pages already open.
2. Retain a kill switch and per-page explicit server placement.
3. Make rollback stop new client placement without moving or destroying
   existing client pages.
4. Keep a separate emergency revocation that fences live leases and routes
   when continued operation is unsafe.
5. Remove desktop-only assumptions from the old remote-image pane.
6. Keep `browser.screencast.v1` for server pages and older clients.

## Test Plan

### Protocol and flow control

- Encode/decode every control and tunnel opcode.
- Reject wrong versions, invalid lengths, oversized payloads, and unknown
  opcodes.
- Pause and resume source sockets at exact credit boundaries.
- Bound per-stream and aggregate memory under non-reading peers.
- Reject stream-ID reuse, credit overflow, duplicate opens, and invalid
  half-close transitions.
- Include WebSocket and destination socket queues in retained-byte bounds.
- Enforce concurrent-stream, pending-open, open-rate, and connect-time limits.
- Prove fair scheduling and cleanup under cancellation and abrupt close.
- Close stale-generation frames after reconnect.
- Prove bulk tunnel traffic cannot delay the host-control socket.
- Keep large binary command results and mirror frames off the control socket.
- Deduplicate repeated command IDs and report unknown outcomes without
  replaying side effects.
- Reject an old command sequence after its cached result expires instead of
  applying it again.
- Preserve FIFO mutation ordering per page while allowing bounded cross-page
  concurrency.

### Browser routing

- Create a client page only after the exact host lease acknowledges it.
- Apply and verify the partition proxy before the first `src` or `loadURL` for
  create, restore, popup, and profile-switch paths.
- Reject ambiguous host selection instead of choosing an arbitrary paired
  desktop.
- Advertise client-host and tunnel capabilities without a runtime browser
  backend.
- Reject server placement on a browserless runtime without disabling client
  placement.
- Reconcile missing, matching, and orphaned pages after lost acknowledgements,
  runtime restart, renderer reload, and client crash.
- Reauthorize an exact old-epoch page with a new generation while rejecting
  mismatched or unpersisted old-epoch pages.
- Drop late command results and page events from replaced epochs or
  generations.
- Apply page event revisions in order and make terminal close win over later
  metadata.
- Route every existing browser command to the correct placement.
- Return `browser_host_unavailable` without creating a replacement page.
- Preserve stable page IDs through React detach/reattach.
- Keep identical page IDs from two runtime authorities isolated in every
  registry and event path.
- Scope partitions by Orca profile, browser profile, runtime authority, and
  execution host.
- Prove a named browser profile does not synchronize live cookies or workers
  between execution hosts; profile import is a one-time scoped copy.
- Prevent deleted-and-readded runtime, SSH, and WSL records with recycled
  names from inheriting old partitions without explicit adoption.
- Prove a partition proxy is never retargeted to a different execution host.
- Recreate pages on profile or execution-host change rather than adopting the
  old `WebContents`.
- Show the correct non-spoofable execution-host label for identical loopback
  URLs on different hosts and in sensitive prompts.
- Preserve the origin/host escape affordance through HTML fullscreen, popup,
  picture-in-picture, and DevTools flows.
- Consume, commit, replenish, expire, and reject generation-scoped popup
  reservations; never create an unregistered guest when the pool is empty.
- Give only one pane an interactive attachment to a logical page.
- Suspend pages on renderer crash or last-hosting-window close.
- Protect active commands, transfers, dialogs, permission prompts, media,
  DevTools, mirrors, and known `beforeunload` pages from LRU discard.
- Mark discarded pages visibly and restore them with a new page generation.
- Never auto-restore, take over, or reopen a non-idempotent main-frame request
  by converting it to a GET or replaying its body.

### Network behavior

- Remote `localhost`, `.localhost`, `localhost.`, the full `127.0.0.0/8`
  range, accepted numeric IPv4 forms, IPv4-mapped IPv6, `::1`, `0.0.0.0`, and
  `[::]`.
- Remote and public DNS names with no local DNS fallback.
- Split-horizon name that resolves differently on the desktop, paired runtime,
  SSH jump host, WSL host, and final execution host.
- IDN/punycode, trailing-dot names, dual-stack DNS, IPv6 literals, NXDOMAIN,
  timeout, and invalid host/port inputs.
- HTTP, HTTPS, HTTP/2 fallback, WebSocket, redirects, service workers, shared
  workers, background fetches, speculative preconnect, and range requests.
- Restart with a persisted service worker and prove it cannot run before the
  partition proxy and route are ready.
- Private Network Access preflights and secure-context behavior for remote
  loopback origins.
- Disable or fail closed for QUIC, WebTransport over UDP, direct WebRTC, mDNS,
  and every unsupported UDP path.
- Capture desktop DNS and socket activity during tests to prove there is no
  direct fallback, including secure DNS/DoH.
- Audit browser-global safe-browsing, prediction, spellcheck, translation,
  crash, and telemetry services for direct traffic or page-data leakage.
- Replace a tunnel generation without changing the stable local proxy
  endpoint; cover the OS-error path that must replace it.
- Share a listener only across partitions with the same authority connection
  and execution host; isolate different Orca profiles and credentials.
- Keep a route alive for background workers and terminate it on explicit
  revocation or bounded no-page idle expiry.
- Exercise direct egress, supported upstream proxies, proxy authentication
  failure, and PAC-ineligible hosts.
- Proxy authentication/lifetime and non-loopback connection rejection.
- Unsupported UDP and proxy commands fail closed.
- Downloads, uploads, clipboard, popups, external protocols, permissions,
  client certificates, integrated authentication, WebAuthn, and certificate
  errors.
- Block client-hosted `file://` navigation and subresources without exposing
  either desktop or remote filesystem paths.
- Prove remote-routed `localhost` receives no desktop-local permission grant
  based only on its hostname.

### Headed host and terminal links

Add a headed-host plus paired-Electron E2E scenario alongside the existing
headless coverage:

- Launch a full headed Electron app as the paired remote host and connect a
  paired Electron client.
- Create or reveal a remote terminal, print an HTTP URL, and click it.
- Verify the expected browser placement creates the page and loads it.
- Verify the client mirrors or hosts the page according to negotiated
  placement.
- Verify the terminal retains the same PTY handle.
- Verify the terminal multiplex subscription remains open, with no
  unsubscribe/resubscribe cycle.
- Verify no reconnect banner or error toast appears.
- Run the headed-host compatibility scenario again with the host window
  hidden or backgrounded, exercising the `RendererPublicationThrottle`
  lease.
- Assert each Stage 0 structured failure stage — `renderer_ipc`,
  `webview_registration`, `session_tab_publication` — surfaces distinctly and
  rolls back the uncommitted tab.
- Keep separate tests for headless offscreen placement, browserless client
  placement, and mixed-version fallback; a pass on one topology does not
  substitute for another.

### Host matrix

- macOS, Linux, and Windows Electron clients.
- Headed Electron app acting as the paired remote host, with the host window
  visible, hidden, and backgrounded.
- Headless `orca serve` with no display server or runtime browser backend.
- Headless `orca serve` with the optional offscreen browser backend.
- Paired runtime over LAN, WSS reverse proxy, Tailscale, and relay.
- Native SSH2, system SSH, ProxyJump, ProxyCommand, reconnect, and persisted
  connection reuse.
- WSL distro isolation, shutdown, restart, and default-distro changes.
- Git worktree and folder workspace targeting.

### Lifecycle

- Runtime restart, desktop restart, network loss, sleep/wake, environment
  removal, page close, and app shutdown.
- Browser guest crash, renderer crash, last window close, hung host, and
  Electron network-service/utility crash, and authority epoch replacement.
- Lost create acknowledgement, lost mutating-command result, duplicated
  command delivery, navigation during close, and close during capture.
- Control-only loss, tunnel-only loss, and one channel recovering before the
  other.
- Page `offline`/`online` behavior follows tunnel loss and recovery.
- Reconnect never automatically replays POST navigation or form submission.
- Resolve an offline pending close before reconciliation can restore the page.
- Graceful same-client reclaim and expired grace.
- Explicit desktop takeover and explicit reopen-on-server.
- Profile deletion, execution-host reassignment, SSH target replacement,
  SSH host-key change, pairing credential rotation/revocation, and sign-out.
- Git worktree and folder-workspace rename, removal, and reassignment while a
  page is active.
- Retain pixels on transient loss but destroy them on explicit authorization
  revocation.
- Mobile subscribe/unsubscribe while a client page is active.
- No local-network or local-loopback navigation during any failure path.

### Input and mirroring

- Block pointer, keyboard, focus, drag, clipboard, and IME input immediately
  when desktop ownership is revoked.
- Reject stale mobile and agent owner generations.
- Serialize agent mutation ownership against direct desktop input and cancel
  automation before explicit user takeover.
- Fence the old desktop before a takeover page is created.
- Put mirror traffic on its own bounded binary subscription.
- Stop capture and discard queued frames on unsubscribe or authorization loss.
- Enforce OS-session and Orca profile lock policy for capture, synthetic input,
  and new network activity.
- Reject coordinates from stale frames and map zoom, scale factor, and viewport
  correctly.
- Keep the desktop viewport stable when mobile subscribes.

### Performance

- Interactive page on 20, 80, and 200 ms RTT links.
- Constrained 1, 5, and 20 Mbps links with packet loss.
- Large download alongside agent evaluation and host heartbeat.
- Large screenshot, PDF, snapshot, and mobile mirror alongside heartbeats.
- Many parallel browser connections without unbounded retained bytes.
- Background workers and hidden protected pages without unbounded routes or
  memory.
- Compare local page interaction and memory against the existing server
  screencast path.

## Risks

- **Client-local storage changes cross-device semantics.** The placement is
  explicit and never presented as transparent migration.
- **A local browser expands the desktop attack surface.** Keep remote content
  in a sandboxed guest with no Orca IPC, Node, preload, privileged scheme, or
  unregistered popup access.
- **Private remote certificate authorities are not locally trusted.** Surface
  the error and support explicit server placement.
- **Remote enterprise browser policy may not transfer.** Treat required
  upstream proxies, PAC, integrated authentication, client certificates, and
  managed browser policy as placement eligibility, not as details to ignore.
- **Unsupported UDP can escape a TCP-only design.** Disable QUIC, direct
  WebRTC, mDNS, and other non-proxied paths until a tunnel version explicitly
  supports and tests them.
- **Chromium SOCKS no-auth exposes the route to trusted local processes.**
  Loopback and port randomness are not authentication; require an explicit
  desktop threat-model decision or an authenticated/OS-isolated front proxy.
- **SOCKS-over-WebSocket adds TCP-over-TCP head-of-line behavior.** Keep browser
  bulk traffic on its own connection, measure it, and add a small tunnel lane
  pool only if evidence shows one connection is insufficient.
- **A hosting desktop becomes required for that page.** Keep lease grace,
  explicit takeover, and server-hosted page creation; do not invent state
  transfer.
- **Mobile mirroring can reintroduce frame latency.** It is on demand, bounded,
  latest-wins, and outside the hosting desktop's direct input path.
- **Bounded tab retention can discard transient state.** Protect observable
  active work, visibly mark every discard, and never describe URL restoration
  as state preservation.
- **Desktop and runtime Chromium versions can differ.** Placement and takeover
  are explicit, and compatibility-sensitive sites retain runtime placement as
  a fallback.
- **Client placement creates a hybrid fingerprint.** Product copy and
  automation diagnostics distinguish remote network identity from local
  platform, timezone, locale, fonts, GPU, and devices.
- **Electron proxy bypass behavior can differ across versions.** Add real
  Electron tests proving DNS, TCP, UDP, loopback, workers, and speculative
  requests never escape to the desktop.
- **System SSH and SSH2 have different forwarding primitives.** Hide them
  behind the browser-network-route boundary and test both providers.

## Lightweight Eng Review

- Scope: Replaces the default desktop remote-browser data plane without
  removing server-hosted browsing. Includes a Stage 0 mixed-version
  compatibility fix for the current server-hosted headed-Electron creation
  path; that fix is not the target architecture. Cookie synchronization,
  transparent engine migration, and general VPN behavior are excluded.
- Architecture/data flow: Runtime owns logical pages and command brokerage;
  desktop main owns the browser engine registry and network proxy; execution
  adapters own TCP reachability; renderer owns only pane attachment and visible
  status.
- Failure behavior: Tunnel loss fails closed, browser placement never changes
  silently, control and network authorization are correlated, stale epochs and
  generations cannot mutate pages, ambiguous command outcomes are not replayed,
  and missing hosts return a specific unavailable error.
- Security: Proxy and partition policy exist before the first guest request;
  unsupported DNS/UDP paths fail closed; remote loopback never receives
  desktop-local permission trust; remote content has no Orca IPC or filesystem
  bridge.
- Cross-platform: Electron proxying and Node sockets are platform-neutral;
  SSH2 and system SSH keep separate adapters; paths and workspaces are resolved
  through existing execution-host identity.
- SSH/folder parity: Route selection is independent of Git and uses the same
  execution-host resolution for folder workspaces and worktrees.
- Performance: Desktop interaction no longer transports pixels or input over
  WAN. Browser network traffic remains remote, bounded, and isolated from host
  control.
- Residual risk: Client placement deliberately changes where browser storage,
  downloads, TLS validation, transient state, devices, and browser fingerprint
  live. Product copy and explicit placement controls must remain honest about
  those boundaries.
