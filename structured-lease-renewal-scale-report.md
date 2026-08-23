# Structured lease-renewal scale report

## Outcome

The 50-record renewal sweep now performs one durable store transaction and one Darwin process-table command. Structured-chat focus refresh is registered only while a chat pane is visible.

## Measurements

Measured on base `8572614c38` with the same 50-record durable benchmark:

| Path                               |                     Before |                        After |
| ---------------------------------- | -------------------------: | ---------------------------: |
| Durable renewal sweep, median of 3 |                   5,358 ms |                      30.1 ms |
| Durable renewal sweep, samples     |   6,772 / 5,358 / 4,445 ms |        51.3 / 26.1 / 30.1 ms |
| Darwin process liveness            | 1,268 ms, 50 `ps` children | 11.0 ms median, 1 `ps` child |

The durable sweep improved about 178x at 50 records. The process probe now asks one targeted `ps` invocation for all unique owner PIDs and retains the same PID-presence, start-time tolerance, spawn-token, contradiction, and indeterminate-result rules.

## Semantics

- `renewLeases` applies every per-record fence check inside one transaction. A stale or superseded fence aborts the full sweep; the transaction queue restores every in-memory map and does not publish a new file.
- Persistence continues to write and fsync a temp file, copy the still-live primary to the backup, then atomically rename the temp over the primary. The live primary is never renamed aside or absent.
- Renewal still considers every live, reconciled owner every 10 seconds. I did not add a near-expiry skip: the 10-second pass also re-proves liveness and drives dead-TUI recovery, while moving to a 20-second cadence would leave only one timer interval before the 30-second deadline. With the measured 30 ms batch, keeping the existing safety cadence is cheap and preserves semantics.
- Focus refresh is scoped to visible structured chats. Hidden mounted chats keep their existing stream subscription but install no `window.focus` handler and issue no focus-triggered history RPC.

## Concurrent app-server cap

No hard cap belongs in this fix. Fifty idle servers consume meaningful memory but remain viable on the measured 64 GiB machine, and a fixed global number would arbitrarily reject valid workflows on larger hosts while still being unsafe on smaller ones. If product policy needs admission control later, it should be a resource-aware budget with explicit queued/parked UX at the app-server launch boundary, not a hidden numeric cap in lease renewal.

## Verification

- Targeted suites: 91 tests passed across the record store, renewal batching, process identity, structured runtime, structured read/focus, and structured session behavior.
- New correctness coverage proves stale-fence refusal, superseded-record refusal, full in-memory and on-disk rollback, and successful reopening of every record.
- RED proof: temporarily changing the renewer back to one `renewLeases([record])` call per record made `commits one store transaction for the whole live-record sweep` fail with `expected ... once, but got 2 times`; restoring the batch made it pass.
- `pnpm run typecheck`, `pnpm exec oxlint`, and targeted `pnpm exec oxfmt --check` were run. A repo-wide `oxfmt --check .` also ran and reported 40 pre-existing unrelated files, including owner-authored untracked artifacts; none were modified.
