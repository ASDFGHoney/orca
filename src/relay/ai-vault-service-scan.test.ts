import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorBucketForCwd } from '../main/ai-vault/session-scanner-cursor-paths'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { createRelayAiVaultFilesystemProvider } from './ai-vault-service-filesystem'
import { scanRelayAiVaultSessions } from './ai-vault-service-scan'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('relay AI Vault owning-host scan', () => {
  it('discovers bounded Cursor sidecars on the relay host', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'orca-relay-cursor-sidecar-'))
    tempRoots.push(remoteHome)
    const workspace = join(remoteHome, 'workspace')
    const sessionId = 'relay-sidecar-session'
    const sessionDir = join(
      remoteHome,
      '.cursor',
      'chats',
      cursorBucketForCwd(workspace, 'linux'),
      sessionId
    )
    await Promise.all([mkdir(workspace), mkdir(sessionDir, { recursive: true })])
    await Promise.all([
      writeFile(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          createdAtMs: 1_750_000_000_000,
          updatedAtMs: 1_750_000_001_000,
          hasConversation: true,
          title: 'Relay Cursor sidecar',
          cwd: workspace
        })
      ),
      writeFile(join(sessionDir, 'store.db'), '')
    ])

    const result = await scanRelayAiVaultSessions({
      provider: createRelayAiVaultFilesystemProvider(),
      remoteHome,
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      limit: 10
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'local',
      agent: 'cursor',
      sessionId,
      title: 'Relay Cursor sidecar',
      cwd: workspace,
      filePath: join(sessionDir, 'meta.json'),
      messageCount: 1,
      hasConversation: true
    })
  })
})
