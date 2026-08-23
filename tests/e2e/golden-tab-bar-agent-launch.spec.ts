import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_AGENTS,
  GOLDEN_STUB_READY_MARKER,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import {
  getFirstWslDistro,
  removeWslGoldenStubAgent,
  stageWslGoldenStubAgent,
  useWslRuntimeForActiveProject
} from './helpers/wsl-golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'
import type { BuiltInWindowsTerminalShell } from '../../src/shared/windows-terminal-shell'

// Covers the full tab-bar `+` agent launch chain — detection row, startup-plan
// build, tab create, PTY spawn under the configured runtime, startup-command
// injection. golden-agent-tui-launch.spec.ts covers one agent on the default
// shell and never runs in the Windows golden lane, so a Windows-only break
// anywhere in that chain ships as "clicking an agent does nothing".

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

const WINDOWS_SHELLS: readonly BuiltInWindowsTerminalShell[] = [
  'powershell.exe',
  'cmd.exe',
  'git-bash'
]

async function openWorkspaceTerminal(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
}

for (const { id, menuItemName } of GOLDEN_STUB_AGENTS) {
  test(`tab-bar + menu launches ${id} into a live TUI @tab-bar-agent-launch-golden`, async ({
    orcaPage
  }) => {
    await openWorkspaceTerminal(orcaPage)
    await configureGoldenStubAgent(orcaPage, { agent: id })
    await launchGoldenStubAgentFromNewTab(orcaPage, menuItemName)

    const activeTab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
    await expect(activeTab).toHaveAttribute('data-tab-title', /Golden Stub Agent|Codex|Claude/i)
    // Why the banner and not just the tab: a tab that spawned a bare shell
    // instead of the agent looks identical at the store/tab layer.
    expect(await getTerminalContent(orcaPage)).toContain(GOLDEN_STUB_READY_MARKER)
  })
}

// Why describe-scoped and not a body-level skip: `orcaPage` builds before the
// test body, so a body-level skip still pays a full Electron launch per case.
test.describe('Windows runtimes', () => {
  test.skip(process.platform !== 'win32', 'Windows agent launch matrix is Windows-only')

  for (const shell of WINDOWS_SHELLS) {
    test(`tab-bar + menu launches an agent under ${shell} @tab-bar-agent-launch-golden`, async ({
      orcaPage
    }) => {
      await openWorkspaceTerminal(orcaPage)
      // Why each shell: the queued launch command is quoted for the shell family
      // the tab actually spawns (posix for Git Bash, cmd, PowerShell). A mismatch
      // injects a command the shell rejects, and the agent never starts.
      await configureGoldenStubAgent(orcaPage, { agent: 'codex', windowsShell: shell })
      await launchGoldenStubAgentFromNewTab(orcaPage)

      expect(await getTerminalContent(orcaPage)).toContain(GOLDEN_STUB_READY_MARKER)
    })
  }

  test('tab-bar + menu launches an agent inside WSL @tab-bar-agent-launch-golden', async ({
    orcaPage
  }) => {
    await openWorkspaceTerminal(orcaPage)

    const distro = await getFirstWslDistro(orcaPage)
    test.skip(!distro, 'No WSL distro is available on this Windows host')
    test.skip(
      !stageWslGoldenStubAgent(distro!),
      'WSL distro would not accept the staged stub agent'
    )

    try {
      // Why the runtime switch and not terminalWindowsShell: WSL is a project
      // runtime, so it must retarget agent detection into the distro as well as
      // the PTY. A launch quoted for a Windows shell never starts there.
      await useWslRuntimeForActiveProject(orcaPage, distro!)
      await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
      await launchGoldenStubAgentFromNewTab(orcaPage)

      // The stub only exists inside the distro, so its marker proves the agent
      // ran in WSL rather than on the Windows host.
      expect(await getTerminalContent(orcaPage)).toContain(GOLDEN_STUB_READY_MARKER)
    } finally {
      removeWslGoldenStubAgent(distro!)
    }
  })
})
