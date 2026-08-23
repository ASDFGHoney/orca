import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { GitHubWorkItem } from '../../src/shared/github/work-item-types'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const TARGET_URL = 'https://github.com/stablyai/orca/issues/4242'
const WRONG_TITLE = 'Wrong cached issue'
const TARGET_TITLE = 'Exact pasted issue'

const WRONG_ITEM: GitHubWorkItem = {
  id: 'issue-17',
  type: 'issue',
  number: 17,
  title: WRONG_TITLE,
  state: 'open',
  url: 'https://github.com/stablyai/orca/issues/17',
  labels: [],
  updatedAt: '2026-08-01T00:00:00.000Z',
  author: 'e2e',
  repoId: 'e2e-repo'
}

const TARGET_ITEM: GitHubWorkItem = {
  ...WRONG_ITEM,
  id: 'issue-4242',
  number: 4242,
  title: TARGET_TITLE,
  url: TARGET_URL,
  updatedAt: '2026-08-02T00:00:00.000Z'
}

type TransitionFrame = {
  value: string
  wrongVisible: boolean
  wrongSelected: boolean
  targetVisible: boolean
  targetSelected: boolean
}

function pasteChord(): string {
  return process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
}

async function installHeldGitHubLookup(
  electronApp: ElectronApplication,
  page: Page
): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, targetItem) => {
    const fixture = globalThis as unknown as {
      __githubUrlLookupStarted?: boolean
      __releaseGitHubUrlLookup?: () => void
    }
    fixture.__githubUrlLookupStarted = false
    ipcMain.removeHandler('gh:workItemByOwnerRepo')
    ipcMain.handle('gh:workItemByOwnerRepo', () => {
      fixture.__githubUrlLookupStarted = true
      return new Promise((resolve) => {
        fixture.__releaseGitHubUrlLookup = () => resolve(targetItem)
      })
    })
  }, TARGET_ITEM)
  await page.evaluate((wrongItem) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.setState({
      getCachedWorkItems: () => [wrongItem],
      fetchWorkItems: async () => [wrongItem],
      fetchWorkItemsAcrossRepos: async () => ({
        items: [wrongItem],
        failedCount: 0,
        githubUnavailable: false
      })
    })
  }, WRONG_ITEM)
}

async function releaseGitHubLookup(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const fixture = globalThis as unknown as { __releaseGitHubUrlLookup?: () => void }
    if (!fixture.__releaseGitHubUrlLookup) {
      throw new Error('GitHub lookup is not held')
    }
    fixture.__releaseGitHubUrlLookup()
  })
}

test('a pasted GitHub URL never selects a stale cached issue', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await installHeldGitHubLookup(electronApp, orcaPage)

  await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  const input = dialog.locator('[data-workspace-name-input="true"]')
  await expect(input).toBeVisible()
  await input.click()

  const wrongOption = orcaPage.getByRole('option', { name: `#17 ${WRONG_TITLE}`, exact: true })
  const targetOption = orcaPage.getByRole('option', {
    name: `#4242 ${TARGET_TITLE}`,
    exact: true
  })
  await expect(wrongOption).toBeVisible()

  await orcaPage.evaluate(
    ({ wrongTitle, targetTitle }) => {
      const frames: TransitionFrame[] = []
      const capture = (): void => {
        const input = document.querySelector<HTMLInputElement>('[data-workspace-name-input="true"]')
        const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        const wrong = options.find((option) => option.textContent?.includes(wrongTitle))
        const target = options.find((option) => option.textContent?.includes(targetTitle))
        frames.push({
          value: input?.value ?? '',
          wrongVisible: Boolean(wrong && wrong.getClientRects().length > 0),
          wrongSelected: wrong?.dataset.selected === 'true',
          targetVisible: Boolean(target && target.getClientRects().length > 0),
          targetSelected: target?.dataset.selected === 'true'
        })
        requestAnimationFrame(capture)
      }
      Reflect.set(window, '__githubUrlTransitionFrames', frames)
      capture()
    },
    { wrongTitle: WRONG_TITLE, targetTitle: TARGET_TITLE }
  )

  await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), TARGET_URL)
  await input.focus()
  await orcaPage.keyboard.press(pasteChord())
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const fixture = globalThis as unknown as { __githubUrlLookupStarted?: boolean }
        return fixture.__githubUrlLookupStarted === true
      })
    )
    .toBe(true)
  await expect
    .poll(() =>
      orcaPage.evaluate((url) => {
        const frames = Reflect.get(window, '__githubUrlTransitionFrames') as TransitionFrame[]
        return frames.filter((frame) => frame.value === url).length
      }, TARGET_URL)
    )
    .toBeGreaterThan(10)
  await expect(wrongOption).toHaveCount(0)
  await expect(targetOption).toHaveCount(0)

  await releaseGitHubLookup(electronApp)
  await expect(targetOption).toBeVisible()
  await expect(targetOption).toHaveAttribute('data-selected', 'true')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => {
        const frames = Reflect.get(window, '__githubUrlTransitionFrames') as TransitionFrame[]
        return frames.some((frame) => frame.targetVisible && frame.targetSelected)
      })
    )
    .toBe(true)

  const frames = await orcaPage.evaluate(() => {
    return Reflect.get(window, '__githubUrlTransitionFrames') as TransitionFrame[]
  })
  const pastedFrames = frames.filter((frame) => frame.value === TARGET_URL)
  expect(frames.some((frame) => frame.wrongVisible)).toBe(true)
  expect(pastedFrames.length).toBeGreaterThan(10)
  expect(pastedFrames.every((frame) => !frame.wrongVisible && !frame.wrongSelected)).toBe(true)
  expect(pastedFrames.some((frame) => frame.targetVisible && frame.targetSelected)).toBe(true)

  await testInfo.attach('github-url-smart-input-fixed.png', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
})
