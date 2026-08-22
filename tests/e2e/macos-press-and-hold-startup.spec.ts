/**
 * Startup wiring for the macOS press-and-hold opt-out (#14746).
 *
 * What this can prove: the routine runs during startup, resolves the *real* running bundle's
 * identifier from its Info.plist, records a decision, and stays completely inert off macOS.
 *
 * What it cannot prove: that held keys repeat. Key repeat versus the accent picker is decided by
 * AppKit from a preference this process does not re-read after writing, so observing it needs a relaunch and a
 * physically held key — neither of which Playwright's synthesized CDP key events go through.
 * The preference semantics the fix depends on are pinned against the real `/usr/bin/defaults` in
 * src/main/macos-press-and-hold-default.defaults-domain.test.ts.
 *
 * The E2E app runs unpackaged, so its bundle identifier is Electron's own rather than Orca's. That
 * is the ownership guard's case, and asserting it here is the point: `defaults` resolves the user's
 * real home regardless of the harness's HOME isolation, so a run that wrote anything would be
 * writing into a domain shared with every other unpackaged Electron app on the machine.
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

type StartupState = {
  recordRaw: string | null
  bundleIdentifier: string | null
  execPath: string
}

async function readPressAndHoldStartupState(
  electronApp: ElectronApplication
): Promise<StartupState> {
  return electronApp.evaluate(({ app }) => {
    const nodeFs = process.getBuiltinModule('node:fs')
    const nodePath = process.getBuiltinModule('node:path')
    const recordPath = nodePath.join(app.getPath('userData'), 'macos-press-and-hold-default.json')
    const read = (file: string): string | null => {
      try {
        return nodeFs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    }
    // Why resolved here rather than hardcoded: this is the independent half of the cross-check —
    // the spec derives the identifier from the launched bundle without reusing product code.
    const plist = read(
      nodePath.join(nodePath.dirname(nodePath.dirname(process.execPath)), 'Info.plist')
    )
    const match = plist
      ? /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
      : null
    return {
      recordRaw: read(recordPath),
      bundleIdentifier: match ? match[1].trim() : null,
      execPath: process.execPath
    }
  })
}

/** Round-trips through main's own store, so a value here has crossed the IPC boundary. */
async function readAccentMenuSettingFromMain(page: Page): Promise<boolean | undefined> {
  return page.evaluate(async () => (await window.api.settings.get()).macAccentMenuEnabled)
}

async function setAccentMenuEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(
    async (value) => window.__store?.getState().updateSettings({ macAccentMenuEnabled: value }),
    enabled
  )
}

test.describe('macOS press-and-hold default', () => {
  test.skip(process.platform !== 'darwin', 'macOS-only startup routine')

  test('records a decision for the bundle it is actually running from', async ({ electronApp }) => {
    const state = await readPressAndHoldStartupState(electronApp)

    expect(state.recordRaw, 'startup must leave a decision record').not.toBeNull()
    const record = JSON.parse(state.recordRaw!) as {
      version: number
      decision: string
      domain: string | null
    }

    expect(record.version).toBe(1)
    expect(state.bundleIdentifier).not.toBeNull()
    expect(record.domain).toBe(state.bundleIdentifier)

    const ownsDomain =
      record.domain === 'com.stablyai.orca' || record.domain!.startsWith('com.stablyai.orca.')
    if (ownsDomain) {
      // A packaged or dev-identity bundle: the write path is live and must have settled.
      expect(['applied', 'kept-user-preference']).toContain(record.decision)
    } else {
      // The unpackaged harness. Anything but a refusal means Orca wrote into a foreign domain.
      expect(record.decision).toBe('foreign-bundle')
    }
  })
})

test.describe('macOS accent-menu setting', () => {
  test.skip(process.platform !== 'darwin', 'macOS-only startup routine')

  test('reaches main without writing into a domain Orca does not own', async ({
    electronApp,
    orcaPage
  }) => {
    // What this proves: the toggle's value crosses into main, and the ownership guard still refuses
    // there. The harness runs unpackaged, so a write would land in the domain every other unpackaged
    // Electron app on this machine shares.
    //
    // What it cannot prove: that the settings listener fired. Its only observable effect is the
    // domain write the guard refuses here, so an unpackaged run cannot tell a refusal from missing
    // wiring. The call sites are pinned by source position in the unit test instead.
    const before = await readPressAndHoldStartupState(electronApp)
    expect((JSON.parse(before.recordRaw!) as { decision: string }).decision).toBe('foreign-bundle')

    await setAccentMenuEnabled(orcaPage, true)
    await expect.poll(() => readAccentMenuSettingFromMain(orcaPage)).toBe(true)
    expect((await readPressAndHoldStartupState(electronApp)).recordRaw).toBe(before.recordRaw)
  })
})

test.describe('off macOS', () => {
  test.skip(process.platform === 'darwin', 'covers the non-macOS branch')

  test('writes nothing at all', async ({ electronApp }) => {
    const state = await readPressAndHoldStartupState(electronApp)

    expect(state.recordRaw).toBeNull()
  })
})
