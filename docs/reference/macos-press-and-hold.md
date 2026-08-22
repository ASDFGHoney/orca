# macOS press-and-hold and key repeat

macOS routes press-and-hold to the accent picker unless an application opts out for its own
preferences domain, so holding `j` in vim inserted one character instead of repeating (#14746).
The `ApplePressAndHoldEnabled` key is unset by default, which is why terminal-hosting Mac apps
ship this opt-out. Orca writes `false` into `com.stablyai.orca` so held keys repeat.

Two properties are easy to break and worth stating plainly.

**The preference is per-application, not per-view.** It reaches every text surface in Orca — the
Markdown editor and every input field, not only terminals. Anyone reasoning about this as a
terminal setting will get the blast radius wrong.

**The write lands for the *next* launch.** AppKit reads the preference as the process starts, so
nothing changes in the session that performs the write. Every user-facing control for it has to
say so.

## Precedence

Three things can decide the key. Highest wins.

1. **The `macAccentMenuEnabled` setting** (Terminal → Advanced → macOS keyboard, desktop macOS
   only). `undefined` until the user touches it. Once set, Orca owns the key and writes the value
   the toggle asks for — `ApplePressAndHoldEnabled` *is* the accent-menu switch, so the toggle maps
   straight through with no inversion.
2. **An explicit value already in the domain**, from a hand-run
   `defaults write com.stablyai.orca ApplePressAndHoldEnabled -bool true`. Left alone.
3. **The one-time default.** If the key is unset and nothing above applies, Orca writes `false`
   once and records that it did.

The decision is recorded in `<userData>/macos-press-and-hold-default.json`. Two fields carry the
no-clobber guarantee:

- `decision` — a terminal value (`applied`, `kept-user-preference`, `followed-setting`) stops the
  one-time default from ever touching the domain again, including after the user deletes the key.
- `appliedSetting` — the toggle value last written. The setting path compares against *this*, not
  against the domain, so a `defaults write` run after using the toggle is the newer choice and
  survives the next launch. Dropping this field on read would rewrite the domain every launch,
  which is the exact clobbering the design exists to prevent.

## Why `defaults read` and not `systemPreferences.getUserDefault`

`getUserDefault` reads through the whole NSUserDefaults search list and is typed non-nullable, so
an unset key and an explicit `false` both come back `false` — and since the system default is
unset, it reports `false` on a Mac where press-and-hold is on. `defaults read <domain> <key>` is
domain-scoped and exits 1 when the key is absent, which is the only way to tell "unset" from a
deliberate `false`. Only a real exit-1 may be read as unset; a spawn failure or timeout must not be,
or a broken probe would overwrite a value the user chose.

Setting the key in `Info.plist` does nothing: the bundle's `Info.plist` is not part of the
NSUserDefaults search list.

## Reverting

Deleting this code is not enough. AppKit reads the plist, not the source, so removing the code
alone leaves press-and-hold disabled forever for everyone who ran an affected build, with nothing
left in the tree to explain it. A revert must also delete the key.

## What CI does not cover

There is no macOS test runner. The e2e workflow is Ubuntu; the unit-test jobs are Ubuntu and
Windows; the only macOS jobs build and package and run no tests. The tests that pin the
`defaults(1)` exit-code semantics this design rests on, and the real-bundle e2e case, pass on a
developer Mac and execute zero times in a green PR.
