# Remaining work to finish the pty.ts 400-line split

## Done
- Source `src/main/ipc/pty.ts`: **7866 → 39** (thin public-API barrel, no `pty/index.ts`)
- Module-level state/env/cleanup extracted under `src/main/ipc/pty/`
- Delivery, inspect/write/snapshot/resize IPC extracted
- Renderer `pty:spawn` split under `ipc/spawn-*.ts`
- `registerPtyHandlers` is a thin orchestrator over `PtyIpcSession`
- Runtime controller split under `runtime/{spawn,kill,operations}*.ts`
- Oxlint on `src/main/ipc/pty/**` is clean (no max-lines disables)

## After retrying the commit
- `pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/pty.test.ts`
- `pnpm exec tsc --noEmit -p config/tsconfig.node.json` if the commit hook does not already cover it
