import { mkdtempSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

type RuntimeTerminalRead = { tail: string[] }

test('STA-4746: folder-workspace terminal on a headless paired host', async () => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sta4746-')))
    const folderPath = path.join(parent, 'workspace')
    mkdirSync(folderPath, { recursive: true })

    const group = await host.client.call<{ group: { id: string } }>('projectGroup.create', {
      name: 'sta4746-group',
      parentPath: parent
    })
    const groupId = group.result.group.id

    const fw = await host.client.call<{ folderWorkspace: { id: string; folderPath: string } }>(
      'folderWorkspace.create',
      { projectGroupId: groupId, name: 'sta4746-ws', folderPath }
    )
    const folderWorkspaceId = fw.result.folderWorkspace.id
    console.log('[sta4746] folderWorkspace', JSON.stringify(fw.result.folderWorkspace))

    const created = await host.client.call<{
      terminal: { handle: string; worktreeId: string; ptyId?: string }
    }>('terminal.create', { worktree: `folder:${folderWorkspaceId}` })
    console.log('[sta4746] terminal', JSON.stringify(created.result.terminal))

    const marker = 'STA4746PROBE'
    await host.client.call('terminal.send', {
      terminal: created.result.terminal.handle,
      text: `printf '${marker} pwd=%s wt=%s root=%s\\n' "$PWD" "$ORCA_WORKTREE_ID" "$ORCA_WORKSPACE_ROOT"`,
      enter: true
    })

    let observed = ''
    await expect
      .poll(
        async () => {
          const read = await host.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
            terminal: created.result.terminal.handle,
            limit: 200
          })
          const tail = read.result.terminal.tail.join('\n')
          const line = tail
            .split('\n')
            .toReversed()
            .find((l) => l.includes(`${marker} pwd=`) && !l.includes('printf'))
          observed = line ?? ''
          return observed
        },
        { timeout: 60_000 }
      )
      .not.toBe('')

    console.log('[sta4746] OBSERVED:', observed)
    console.log('[sta4746] EXPECTED pwd=', folderPath)
    expect(observed).toContain(`pwd=${folderPath}`)
    expect(observed).toContain(`root=${folderPath}`)
    expect(observed).toContain(`wt=folder:${folderWorkspaceId}`)
  } finally {
    await host.dispose()
  }
})
