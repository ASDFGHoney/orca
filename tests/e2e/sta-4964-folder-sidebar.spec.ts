import { mkdirSync } from 'node:fs'
import type { FolderWorkspace } from '../../src/shared/folder-workspace-types'
import type { ProjectGroup } from '../../src/shared/project-group-types'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'
import { expectFolderWorkspaceSidebarGrouping } from './sta-4964-folder-sidebar-oracle'

test('keeps a runtime-owned folder under its paired host in every grouping mode @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'STA-4964 runtime')
  const runtimeHostId = `runtime:${client.environmentId}` as const
  const runtimeFolderPath = testInfo.outputPath('runtime-folder')
  const localFolderPath = testInfo.outputPath('local-collision-folder')
  mkdirSync(runtimeFolderPath, { recursive: true })
  mkdirSync(localFolderPath, { recursive: true })

  try {
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    await expect.poll(() => client.page.evaluate(() => window.__store != null)).toBe(true)
    const seeded = await client.page.evaluate(
      async (args) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        await store.getState().setActiveRuntimeEnvironmentPreference(null)
        const groupResponse = await window.api.runtimeEnvironments.call({
          selector: args.environmentId,
          method: 'projectGroup.create',
          params: {
            name: 'Runtime-owned group',
            parentPath: args.runtimeFolderPath,
            createdFrom: 'manual'
          },
          timeoutMs: 15_000
        })
        if (!groupResponse.ok) {
          throw new Error(groupResponse.error.message)
        }
        const createdGroup = (groupResponse.result as { group: ProjectGroup }).group
        const folderResponse = await window.api.runtimeEnvironments.call({
          selector: args.environmentId,
          method: 'folderWorkspace.create',
          params: {
            folderPath: args.runtimeFolderPath,
            name: 'Runtime-owned folder',
            projectGroupId: createdGroup.id
          },
          timeoutMs: 15_000
        })
        if (!folderResponse.ok) {
          throw new Error(folderResponse.error.message)
        }
        const createdFolder = (folderResponse.result as { folderWorkspace: FolderWorkspace })
          .folderWorkspace
        await Promise.all([
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: args.environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: args.environmentId })
        ])
        const state = store.getState()
        const runtimeFolder = state.folderWorkspaces.find(
          (workspace) =>
            workspace.id === createdFolder.id && workspace.executionHostId === args.runtimeHostId
        )
        const runtimeGroup = state.projectGroups.find(
          (group) => group.id === createdGroup.id && group.executionHostId === args.runtimeHostId
        )
        if (!runtimeFolder || !runtimeGroup) {
          throw new Error('Runtime-owned folder catalog unavailable')
        }
        const localGroupId = `${runtimeGroup.id}-local-collision`
        store.setState({
          folderWorkspaces: [
            {
              ...runtimeFolder,
              name: 'Local same-ID collision',
              folderPath: args.localFolderPath,
              projectGroupId: localGroupId,
              executionHostId: 'local'
            },
            ...state.folderWorkspaces
          ],
          projectGroups: [
            {
              ...runtimeGroup,
              id: localGroupId,
              name: 'Local same-ID collision',
              parentPath: args.localFolderPath,
              executionHostId: 'local'
            },
            ...state.projectGroups
          ],
          workspaceHostScope: 'all',
          activeWorkspaceExecutionHostId: 'local'
        })
        await Promise.all([
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: args.environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: args.environmentId })
        ])
        return store
          .getState()
          .folderWorkspaces.filter((workspace) => workspace.id === createdFolder.id)
          .map((workspace) => ({
            id: workspace.id,
            executionHostId: workspace.executionHostId
          }))
      },
      {
        environmentId: client.environmentId,
        localFolderPath,
        runtimeFolderPath,
        runtimeHostId
      }
    )
    expect(new Set(seeded.map((workspace) => workspace.id)).size).toBe(1)
    expect(seeded.map((workspace) => workspace.executionHostId)).toEqual(['local', runtimeHostId])

    await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
      store.getState().setRuntimeEnvironmentStatus(environmentId, {
        status: null,
        checkedAt: Date.now()
      })
    }, client.environmentId)
    await expectFolderWorkspaceSidebarGrouping(client.page, testInfo, {
      folderPath: runtimeFolderPath,
      hostId: runtimeHostId,
      localFolderPath,
      screenshotPrefix: 'disconnected'
    })

    const reconnected = await client.page.evaluate(
      async (args) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const response = await window.api.runtimeEnvironments.connect({
          selector: args.environmentId,
          timeoutMs: 15_000
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        store.getState().setRuntimeEnvironmentStatus(args.environmentId, {
          status: response.result,
          checkedAt: Date.now()
        })
        await Promise.all([
          store.getState().fetchProjectGroups({ runtimeEnvironmentId: args.environmentId }),
          store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: args.environmentId })
        ])
        return store
          .getState()
          .folderWorkspaces.filter(
            (workspace) =>
              workspace.folderPath === args.runtimeFolderPath ||
              workspace.folderPath === args.localFolderPath
          )
          .map((workspace) => workspace.executionHostId)
          .sort()
      },
      { environmentId: client.environmentId, localFolderPath, runtimeFolderPath }
    )
    expect(reconnected).toEqual(['local', runtimeHostId])
    await expectFolderWorkspaceSidebarGrouping(client.page, testInfo, {
      folderPath: runtimeFolderPath,
      hostId: runtimeHostId,
      localFolderPath,
      screenshotPrefix: 'reconnected'
    })
  } finally {
    await client.dispose()
  }
})
