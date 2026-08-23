# Codex structured native-chat watchlist coverage

Base: `8572614c38` (`origin/brennanb2025/structured-session-eviction`)

## Tests added or strengthened

### Last surface holder controls teardown

File: `src/main/native-chat/agent-session-wire/structured-agent-session-surface-lifetime.test.ts`

The real `StructuredAgentSessionHost` and `AgentSessionRecordStore` now prove both halves of the multiple-holder rule in one test: the provider child survives the first release, then is evicted immediately after the last surface releases it.

RED mutation: changed `StructuredAgentSessionHolders.remove` so losing the last holder did not arm eviction.

```text
$ pnpm exec vitest run --config config/vitest.config.ts src/main/native-chat/agent-session-wire/structured-agent-session-surface-lifetime.test.ts -t 'keeps the child until the last surface releases it, and not longer'

FAIL ... > a chat that closes > keeps the child until the last surface releases it, and not longer
AssertionError: expected "vi.fn()" to be called with arguments: [ 'session-alpha' ]
Number of calls: 0
Test Files  1 failed (1)
Tests  1 failed | 6 skipped (7)
```

### Last transport holder controls teardown

File: `src/main/runtime/rpc/methods/structured-agent-session-hold.test.ts`

The real RPC dispatcher, subscription-cleanup registry, host, and record store now prove that transport death keeps a provider child until the final holding connection disappears, and no longer.

RED mutation: changed the real holder set to report “last holder” after any holder was removed.

```text
$ pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/rpc/methods/structured-agent-session-hold.test.ts -t 'keeps the child until the last holding connection disappears, and not longer'

FAIL ... > a client that disappears without cleanup > keeps the child until the last holding connection disappears, and not longer
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
Received: [ "session-alpha" ]
Test Files  1 failed (1)
Tests  1 failed | 7 skipped (8)
```

### Plain-terminal `terminal.send` remains unaffected

File: `src/main/runtime/orchestration-structured-chat-lease.test.ts`

The real `agentSessionPtyWriteGate`, runtime terminal handler, and RPC dispatcher now prove a never-adopted terminal still accepts `terminal.send`, writes the exact bytes once, and reports the true byte count while another pane is structured.

RED mutation: made an unbound pane inherit the first structured binding in the real PTY write gate.

```text
$ pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/orchestration-structured-chat-lease.test.ts -t 'accepts terminal.send unchanged for a never-adopted terminal'

FAIL ... > orchestration while Structured Chat owns an agent session > accepts terminal.send unchanged for a never-adopted terminal
- "accepted": true,
- "bytesWritten": 15,
+ "accepted": false,
+ "bytesWritten": 0,
Test Files  1 failed (1)
Tests  1 failed | 6 skipped (7)
```

## Production finding: a nonexistent session reports a successful hold

I wrote the requested real-boundary assertion against the RPC dispatcher, subscription registry, `StructuredAgentSessionHost`, and `AgentSessionRecordStore`, then removed it because production is currently wrong and this coverage-only branch must stay green.

```text
$ pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/rpc/methods/structured-agent-session-hold.test.ts src/main/native-chat/agent-session-wire/structured-agent-session-surface-lifetime.test.ts

FAIL ... > a client that holds a session > does not report a hold when no session child can be acquired
AssertionError: expected true to be false
- Expected: false
+ Received: true
Test Files  1 failed | 1 passed (2)
Tests  1 failed | 15 passed (16)
```

The cause is direct: `resumeHeldStructuredAgentSession` returns successfully when no record exists, so `agentSession.hold` returns `{ held: true }` and leaves a phantom holder. Fixing that is production behavior and was deliberately not included here.

## Coverage already present on the base and not duplicated

- Exact PID targeting is already pinned by `src/main/codex/codex-app-server-client.test.ts`: Windows must invoke `taskkill /pid <exact pid> /t /f`; POSIX must invoke `pkill -KILL -P <exact pid>` and direct-child `SIGKILL`. The exact argument assertions exclude name/pattern matching.
- Active-turn eviction and post-turn eviction already run through the real host, journal event sink, and store in `structured-agent-session-surface-lifetime.test.ts`.
- Journal subscription holds and renderer/transport cleanup already run through the real RPC cleanup registry in `structured-agent-session-hold.test.ts`.
- Mailbox retention/redrive, truthful `worker-start` refusal, truthful `terminal.send` refusal, and plain mailbox delivery already run through the real PTY gate in `orchestration-structured-chat-lease.test.ts`.
- Account-home adoption already uses the real pane-account registry, settings, host, and record store in `src/main/runtime/orca-runtime-structured-tui-adoption-account-home.test.ts`, including explicit wrong-account negatives and unattributable-pane errors.
- Restart orphan teardown/recoverability already uses the real host and store in `src/main/native-chat/agent-session-wire/structured-agent-session-recovery-exits.test.ts`.
- Launch settings, readiness timeout, and rejected prompt delivery already have focused coverage in `launch-agent-in-new-tab.test.ts`, `new-workspace.test.ts`, and `agent-launch-prompt-delivery.test.ts`. Their renderer launch seams remain mocked, so I did not claim them as new real-boundary coverage.

## Deliberately not added because production does not yet satisfy the watchlist

- Secrets: the current store schema still persists arbitrary `launchEnv` data; `agent-session-launch-env-backfill.test.ts` explicitly expects it to survive reopen. A coverage-only test asserting that `MY_COMPANY_CREDS` and another arbitrary variable disappear would fail.
- Secret migration: current serialization reconstructs known fields and does not preserve unknown/future top-level fields. There is no migration that demonstrably scrubs both the live and `.bak` copies while preserving those fields.
- Owner-only permissions: store directory creation uses default `mkdir` permissions and temp files use default `open(..., 'w')` permissions; no explicit owner-only modes are enforced.
- Lease-renewal scale: `StructuredAgentSessionLeaseRenewer.renewNow` maps every live record to `renewRecord`, and every `renewRecord` independently calls both `probe` and `store.renewLease`. The requested one-probe/one-transaction sweep contract is not implemented, so its counting assertion would fail.

## Verification

```text
$ pnpm exec vitest run --config config/vitest.config.ts src/main/native-chat/agent-session-wire/structured-agent-session-surface-lifetime.test.ts src/main/runtime/rpc/methods/structured-agent-session-hold.test.ts src/main/runtime/orchestration-structured-chat-lease.test.ts
Test Files  3 passed (3)
Tests  22 passed (22)

$ pnpm exec oxlint src/main/native-chat/agent-session-wire/structured-agent-session-surface-lifetime.test.ts src/main/runtime/rpc/methods/structured-agent-session-hold.test.ts src/main/runtime/orchestration-structured-chat-lease.test.ts
(no findings)

$ pnpm run check:max-lines-ratchet
max-lines ratchet OK — 188 grandfathered suppression(s), no new bypasses.

$ pnpm exec tsc --noEmit -p config/tsconfig.node.json --composite false
(passed)
```

`pnpm run check:code-quality:changed` could not parse pnpm's Node-engine warning under the installed Node 26 runtime; direct oxlint of every changed file passed.
