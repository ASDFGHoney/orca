import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

const BUNDLE_ID = 'com.if.Amphetamine'

function amphetamine(script: string): string {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' }).trim()
}

function amphetamineInstalled(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  try {
    return amphetamine(`POSIX path of (path to application id "${BUNDLE_ID}")`).length > 0
  } catch {
    return false
  }
}

/** Mirrors the probe Orca uses: presence|secondsRemaining|isTrigger|displaySleepAllowed. */
function readSession(): string {
  return amphetamine(`if application id "${BUNDLE_ID}" is running then
	tell application id "${BUNDLE_ID}"
		if session is active then
			return "active|" & (session time remaining) & "|" & (session is Trigger) & "|" & (display sleep allowed)
		end if
		return "idle|-3|false|false"
	end tell
else
	return "absent|-3|false|false"
end if`)
}

/**
 * Refuse to run against a machine that already has a session.
 *
 * Amphetamine's session is global, so a cleanup here would end a real one the
 * developer started — exactly the thing this feature promises never to do.
 */
function requireIdleAmphetamine(): void {
  const state = readSession()
  expect(state, 'Amphetamine already has an active session; end it before running this suite').toBe(
    'idle|-3|false|false'
  )
}

/** Only ever ends a session this test created. */
function endSessionCreatedByTest(): void {
  try {
    amphetamine(`tell application id "${BUNDLE_ID}" to end session`)
  } catch {
    // Nothing to end.
  }
}

async function selectAmphetamineEngine(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const next = await window.api.settings.set({
      computerAwakeMacosEngine: 'amphetamine',
      computerAwakeMode: 'auto',
      keepComputerAwakeWhileAgentsRun: true
    })
    window.__store?.setState({ settings: next as GlobalSettings })
  })
}

async function postCodexHookEvent(
  electronApp: ElectronApplication,
  paneKey: string,
  eventName: 'UserPromptSubmit' | 'Stop'
): Promise<void> {
  const endpoint = await readHookEndpoint(electronApp)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey,
      tabId: 'e2e-amphetamine-tab',
      worktreeId: 'e2e-amphetamine-worktree',
      env: endpoint.env,
      version: endpoint.version,
      payload: { hook_event_name: eventName, prompt: 'e2e amphetamine prompt' }
    })
  })
  expect(response.status).toBe(204)
}

test.describe('Amphetamine keep-awake engine', () => {
  test.skip(() => !amphetamineInstalled(), 'requires Amphetamine to be installed on the test host')

  /** Set by a test once it has created a session, so cleanup ends only that one. */
  let createdSession = false

  test.beforeEach(() => {
    createdSession = false
  })

  test.afterEach(() => {
    if (createdSession) {
      endSessionCreatedByTest()
    }
  })

  test('holds and releases a real Amphetamine session for a working agent', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    requireIdleAmphetamine()
    await selectAmphetamineEngine(orcaPage)

    const paneKey = `e2e-amphetamine-tab:${randomUUID()}`
    createdSession = true
    await postCodexHookEvent(electronApp, paneKey, 'UserPromptSubmit')

    // secondsRemaining 0 is Amphetamine's indefinite session: it cannot expire
    // out from under a long agent run.
    await expect
      .poll(() => readSession(), {
        timeout: 15_000,
        message: 'Orca did not start an indefinite Amphetamine session'
      })
      .toBe('active|0|false|true')

    await postCodexHookEvent(electronApp, paneKey, 'Stop')
    await expect
      .poll(() => readSession(), {
        timeout: 15_000,
        message: 'Orca did not end its Amphetamine session'
      })
      .toBe('idle|-3|false|false')
  })

  test('adopts a session the user already started instead of replacing it', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    requireIdleAmphetamine()
    await selectAmphetamineEngine(orcaPage)

    // A hand-started 30-minute session that blocks display sleep.
    createdSession = true
    amphetamine(
      `tell application id "${BUNDLE_ID}" to start new session with options {duration:30, interval:minutes, displaySleepAllowed:false}`
    )
    const before = readSession()
    expect(before.startsWith('active|')).toBe(true)
    expect(before.endsWith('|false|false')).toBe(true)

    const paneKey = `e2e-amphetamine-tab:${randomUUID()}`
    await postCodexHookEvent(electronApp, paneKey, 'UserPromptSubmit')
    // Without this the assertions below could pass simply because Orca never
    // processed the hook at all.
    await expect(
      orcaPage.getByRole('button', { name: /^Amphetamine, Agent · Active/ })
    ).toBeVisible({ timeout: 15_000 })
    await postCodexHookEvent(electronApp, paneKey, 'Stop')
    await expect(
      orcaPage.getByRole('button', { name: /^Amphetamine, Agent · Inactive/ })
    ).toBeVisible({ timeout: 15_000 })

    // Still the user's timed, display-sleep-blocking session: neither replaced
    // by Orca's indefinite one, nor ended when Orca stopped.
    const after = readSession()
    expect(after.endsWith('|false|false')).toBe(true)
    const remaining = Number.parseInt(after.split('|')[1] ?? '', 10)
    expect(remaining).toBeGreaterThan(0)
  })
})
