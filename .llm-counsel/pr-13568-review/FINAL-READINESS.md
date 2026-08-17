# Final readiness — PR #13568

Verdict: **P1 residual risk; review loop did not reach CLEAN.** The final head is `8ee8fa4e609468ede62a025063eb627503117e23`, rebased on pinned `origin/main` `be07b43a2b7377b69bed04e0f39bc4cbb70593fc`.

## Checklist

1. SSH / remote / network: credential materialization uses local shared file and macOS Keychain surfaces; no RPC or relay wire contract changed. SSH/remote filesystem behavior is covered by the guarded-write fallback, but live remote network-failure simulation was not run.
2. Crash / cast / retry / growth: reads are guarded, numeric expiry parsing is finite and bounded, and publication failures do not throw through launch preparation. No unbounded collection or retry loop was added.
3. Security / supply chain: no dependency, shell, updater, or network-sink changes; logs remain payload-redacted. Synthetic credential fixtures only.
4. Performance / resources: freshness checks are bounded reads of the existing file and at most two Keychain surfaces; no per-frame or per-keystroke work changed. Full performance profiling was not run.
5. Functional correctness: monotonic expiry guard, file CAS, partial-read handling, managed-file fallback, read-back freshness checks, and snapshot recovery were reviewed and covered by focused tests.
6. Backward compatibility / data loss: numeric-string and epoch-seconds expiry remain supported; unknown surfaces remain preserved until readable. No mobile-facing surface touched; mobile back-compat review is not applicable.
7. Cross-platform / remoting: Linux/Windows paths retain file-only behavior; WSL selection remains isolated. SSHFS/NFS guarded-write fallback was reviewed, but no live Windows/WSL/SSH host was exercised.

## Residual gaps

- macOS Keychain has no external compare-and-swap primitive; a concurrent external writer can still race between final read and Keychain publication. The implementation revalidates before publication and keeps file CAS, but this residual window cannot be eliminated with the available API.
- Electron desktop/platform QA is coordinator-owned and was not claimed here.
- `ref-oss` did not run (skill invocation was unavailable); its workflow was not replicated.

## Validation

- `pnpm run typecheck:node`: passed.
- `npx oxlint` on touched production/tests: passed.
- Claude account suite: 24 files, 227 tests passed after the final fixes.
- Focused changed suite: 9 files, 125 tests passed.
- Mutation proof: replacing the materialization guard with unconditional candidate publication failed the diverged file/Keychain integration test; guard restored.
- Opening readiness was run and saved as `OPENING-READINESS.md`; this is the final readiness pass.

## Review loop

Seven independent same-model rounds ran. Rounds 1–6 found and received fixes for launch-safe failure handling, file CAS/publication, parser consistency, managed fallback, snapshot recovery, and unsupported-filesystem behavior; round 7 still reports the unavoidable external Keychain TOCTOU window, hard-link-less fallback race, and incomplete recovery coverage.
