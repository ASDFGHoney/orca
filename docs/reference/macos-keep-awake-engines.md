# macOS keep-awake engines

Orca can hold its macOS wake assertion two ways. The engine is a user setting
(`computerAwakeMacosEngine`), exposed in the status-bar segment and in
Settings → Agents. It is independent of the On / Agent / Off mode, which decides
*whether* Orca wants the Mac awake at all.

| Engine | Mechanism | Ownership model |
| --- | --- | --- |
| `caffeinate` (default) | `/usr/bin/caffeinate -i -s` child process | Private to Orca. Refcounted by the kernel; other processes' assertions are independent. |
| `amphetamine` | Apple events to `com.if.Amphetamine` | **Shared and singular.** One global session for the whole machine. |

Orca always also holds Electron's `powerSaveBlocker`, on every platform and with
either engine. The engine is an addition, never a replacement.

## Why Amphetamine needs an ownership policy and caffeinate does not

`caffeinate` is a process Orca spawns and kills. Nothing else on the system can
see or disturb it, and killing it cannot affect anyone else.

Amphetamine is the opposite. Its scripting dictionary documents that
`start new session` "ends any existing sessions, including Trigger-based
sessions, before starting a new session", and that `end session` ends whatever
session is current regardless of who started it. There is exactly one session,
it has no identity, and every write is destructive.

Left naive, that produces two silent data-loss bugs:

1. Orca starting its session destroys the user's running session — their timer,
   their Trigger, their display-sleep choice.
2. Orca ending "its" session destroys whatever session is current, which may by
   then be one the user started.

## The rule: the user always wins

Orca is a co-tenant of the session, never its owner by default.

- **Check and act from one osascript invocation.** Two invocations leave a wide
  window — a whole process spawn — in which the user can create or replace a
  session between the read and the write, and the write would then destroy it.
  Both commands are single scripts that decide and act in one `tell` block, so
  the check and the write are consecutive Apple events instead. See the limits
  below: this narrows the race, it does not remove it.
- **Adopt, don't replace.** If the acquire script finds a session that is not
  Orca-shaped it returns `foreign`, having issued no command. Orca records an
  `adopted` hold; its goal is already met and the user's session is untouched.
- **Reclaim, don't adopt, what looks like Orca's.** An Orca-shaped session found
  at acquire time is recorded as `owned`, not `adopted` — after a crash it *is*
  Orca's leaked session, and adopting it would mean never cleaning it up.
- **End only what still looks like its own.** An `adopted` hold is dropped
  without a command. The release script re-tests the shape and ends the session
  only if it still matches; otherwise it reports `foreign` and leaves it.
- **Never end what it cannot read.** If the release command fails, Orca keeps
  the hold and lets the backoff retry rather than guessing. The trade is
  deliberate: a leaked Orca session is visible in Amphetamine's menu bar and
  ends in one click, while silently ending the user's session is neither
  visible nor reliably recoverable.
- **Never touch global preferences.** `allow/prevent display sleep`,
  `allow/prevent screen saver`, `enable/disable closed display mode` and the
  Trigger and Drive Alive commands all mutate the user's *preferences* when no
  session is active. Orca calls none of them.

### What this cannot guarantee

A `tell` block is not a transaction. `tell` is client-side routing, and
AppleScript sends every property read and every command as a separate Apple
event; Amphetamine exposes no session identity and no compare-and-swap. A change
can therefore interleave between the last check and the write, in both
directions:

- Acquire reads no session, the user starts one, and Orca's `start new session`
  then ends it.
- Release confirms Orca's shape, the user replaces the session, and Orca's
  `end session` then ends theirs.

Every shape test in these scripts is a check, not a guarantee. The invariant
"Orca never destroys a session the user started" is therefore not something this
integration can promise — only something it can make very unlikely, which is why
no comment, doc or piece of UI copy here states it as a promise.

The window is sub-millisecond rather than the tens of milliseconds a second
process spawn would cost, and every check sits as close to its write as the API
allows. That is the ceiling this integration can reach; anything stronger would
need an API Amphetamine does not offer. Callers who cannot tolerate the residual
race should use the caffeinate engine, which is private to Orca and shares
nothing.

### Quit racing an in-flight acquire

If quit lands while an acquire is in flight, Orca aborts it and then runs the
synchronous release. Neither step is ordering: aborting only *requests* a kill,
and an Apple event the acquire already sent is processed by Amphetamine on its
own schedule. So a session can appear immediately after a release that found
nothing to end.

A second release runs in that specific case — an acquire was in flight and the
first pass reported `gone` — with the spawn itself supplying the delay. That
covers the realistic window. It is still not a proof: a sufficiently late Apple
event outlives both passes, and nothing can retry once the process has exited.

### A session held when the grant is revoked

Revoking Automation does not end a running Amphetamine session, so Orca keeps
the `owned` classification: restoring the grant and re-picking Amphetamine is
the path that cleans it up. Until then the session persists and the Mac stays
awake. That is visible — Amphetamine's menu bar shows the active session and
ends it in one click — so it is left as a user-recoverable state rather than
given a background retry loop of its own.

### Recovering from an unusable engine

`not-installed` and `automation-denied` stop the engine being used, but the
verdict is not permanent: re-picking Amphetamine in the picker clears it and
retries. That matters because the automation-denied hint tells the user to grant
the permission, and without a retry path nothing would change until relaunch.

### Handing over without a gap

Switching engines does not release the outgoing one first. Amphetamine's first
Apple event can block on the macOS Automation consent dialog for as long as the
user takes to answer, and caffeinate is what covers a lid close in that window.
Caffeinate is therefore kept until the Amphetamine assertion reports a hold,
which it announces so the handover is prompt.

### Session shape, not session identity

Amphetamine exposes no session id, so "is this still mine?" is a shape match:
indefinite (`session time remaining` = 0), not Trigger-driven, display sleep
allowed. Every other shape — timed, Trigger, app-based, date-based, or
display-sleep-blocking — is treated as someone else's and left alone.

The one case this cannot resolve: a user who replaces Orca's session with an
identically shaped indefinite session is indistinguishable from Orca's own, and
Orca may end it on stop. That is accepted deliberately; the alternative is never
cleaning up, which leaves the Mac awake forever after a crash.

An acquire whose outcome is unknown widens that slightly. The command may have
started a session before failing to report it, so Orca claims responsibility for
one even when it had previously adopted the user's — otherwise a session it just
created would never be released. If the user's session is timed, Trigger-driven
or display-sleep-blocking the shape check still protects it; only an identically
shaped indefinite one is at risk, which is the same limit as above reached by a
second route.

### Duration must be explicit

`start new session` without options inherits the user's *default duration*
preference. A user whose default is one hour would get a wake assertion that
expires after an hour while agents are still working. Orca always passes
`{duration:0, interval:0, displaySleepAllowed:true}` — Amphetamine's documented
indefinite form. `displaySleepAllowed:true` matches `caffeinate -i -s`, which
also permits display sleep.

### Adopted sessions can expire

An adopted session may be a 20-minute timer. While Orca wants the Mac awake and
does not own the session, it re-probes on an interval and starts its own session
once the adopted one is gone.

## Failure handling

Amphetamine is optional, so every failure degrades to caffeinate rather than to
nothing:

- **Not installed** (`-1728`/`-10814`) and **Automation refused**
  (`-1743`) are terminal: the engine is marked unavailable, the reason is
  published to the UI, and the awake service starts caffeinate for the live
  session immediately.
- Any other failure is transient: it backs off and retries, and the awake
  service is asked to refresh.
- Install detection resolves the bundle id through Launch Services, which sends
  no Apple event and therefore cannot trigger a consent prompt just to render
  the picker.
- On quit, an owned session is ended **synchronously**, because the event loop
  is gone before an awaited `osascript` could report back and a missed
  `end session` leaves the Mac awake indefinitely.
