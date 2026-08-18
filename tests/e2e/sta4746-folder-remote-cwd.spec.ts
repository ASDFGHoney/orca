import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { stripAnsiEscapeSequences } from '../../src/shared/ansi-escape-sequences'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

type RuntimeTerminalRead = { tail: string[] }

// Why: this is the host-owned half of STA-4746 — the RPC a remote CLI or a
// paired client sends to a windowless `orca serve`. The paired-client half is
// tests/e2e/sta4746-paired-desktop-folder-cwd.spec.ts.
test('STA-4746: folder-workspace terminal on a headless paired host', async () => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sta4746-')))
    const folderPath = path.join(parent, 'workspace')
    mkdirSync(folderPath, { recursive: true })
    // Why: a sibling that has folderPath as a prefix, so a substring match
    // could not stand in for the exact-path assertions below.
    mkdirSync(`${folderPath}-decoy`, { recursive: true })

    const group = await host.client.call<{ group: { id: string } }>('projectGroup.create', {
      name: 'sta4746-group',
      parentPath: parent
    })
    const fw = await host.client.call<{ folderWorkspace: { id: string; folderPath: string } }>(
      'folderWorkspace.create',
      { projectGroupId: group.result.group.id, name: 'sta4746-ws', folderPath }
    )
    const folderWorkspaceId = fw.result.folderWorkspace.id
    expect(fw.result.folderWorkspace.folderPath).toBe(folderPath)

    const created = await host.client.call<{
      terminal: { handle: string; worktreeId: string; ptyId?: string }
    }>('terminal.create', { worktree: `folder:${folderWorkspaceId}` })
    const terminal = created.result.terminal
    expect(terminal.worktreeId).toBe(`folder:${folderWorkspaceId}`)
    // Why: pins that the host daemon owns this PTY under the folder scope,
    // rather than a fallback owner satisfying the path assertion by luck.
    expect(terminal.ptyId).toMatch(new RegExp(`^folder:${folderWorkspaceId}@@`))

    const marker = 'STA4746HEADLESS'
    await host.client.call('terminal.send', {
      terminal: terminal.handle,
      // `end=1` last: a wrapped row can be read half-rendered, and asserting a
      // truncated path as the real cwd would be a false pass.
      text: `printf '${marker};;pwd=%s;;wt=%s;;root=%s;;end=1\\n' "$PWD" "$ORCA_WORKTREE_ID" "$ORCA_WORKSPACE_ROOT"`,
      enter: true
    })

    let fields: Record<string, string> = {}
    await expect
      .poll(
        async () => {
          const read = await host.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
            terminal: terminal.handle,
            limit: 200
          })
          const line = read.result.terminal.tail
            .toReversed()
            .find(
              (candidate) => candidate.includes(`${marker};;pwd=`) && !candidate.includes('printf')
            )
          fields = Object.fromEntries(
            stripAnsiEscapeSequences(line ?? '')
              .split(';;')
              .map((chunk) => chunk.split('='))
              .filter((parts) => parts.length === 2)
              .map(([key, value]) => [key.trim(), value.trim()])
          )
          return fields.end === '1' ? (fields.pwd ?? '') : ''
        },
        { timeout: 60_000 }
      )
      .not.toBe('')

    expect(fields.pwd).toBe(folderPath)
    expect(fields.root).toBe(folderPath)
    expect(fields.wt).toBe(`folder:${folderWorkspaceId}`)
  } finally {
    await host.dispose()
  }
})
