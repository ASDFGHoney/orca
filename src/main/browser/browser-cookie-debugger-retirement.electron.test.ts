import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

type FixtureResult = {
  step: string
  firstError: { name: string; message: string } | null
  events: string[]
  recoveredCookieValues: string[]
}

function fixtureMain(bundlePath: string, resultPath: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const {
  openCookieClearStore,
  sendCookieDebuggerCommand,
  withCookieMutationLock
} = require(${JSON.stringify(bundlePath)})
const resultPath = ${JSON.stringify(resultPath)}
let step = 'starting'
const events = []
const mark = (value) => {
  step = value
  writeFileSync(resultPath, JSON.stringify({ step, events }))
}

async function run() {
  const fixtureTimeout = setTimeout(() => {
    writeFileSync(resultPath, JSON.stringify({ step: 'timed out after ' + step, events }))
    app.exit(1)
  }, 40000)
  await app.whenReady()
  const partition = 'persist:cookie-debugger-retirement-test'
  const targetSession = session.fromPartition(partition)
  const keeper = new BrowserWindow({ show: false })
  await keeper.loadURL('data:text/html,<title>fixture keeper</title>')
  const firstWindow = new BrowserWindow({
    show: false,
    webPreferences: { session: targetSession, sandbox: true, contextIsolation: true }
  })
  await firstWindow.loadURL('data:text/html,<title>wedged cookie debugger</title>')
  const firstDebugger = firstWindow.webContents.debugger
  firstDebugger.attach('1.3')

  let firstError = null
  const first = withCookieMutationLock(targetSession, async () => {
    events.push('first:start')
    try {
      await sendCookieDebuggerCommand(
        { debugger: firstDebugger },
        'Runtime.evaluate',
        { expression: 'new Promise(() => {})', awaitPromise: true },
        () => {
          events.push('first:retire')
          if (firstDebugger.isAttached()) firstDebugger.detach()
          firstWindow.destroy()
        }
      )
    } catch (error) {
      firstError = { name: error?.name || '', message: String(error?.message || error) }
      events.push('first:error')
    }
  })

  const second = withCookieMutationLock(targetSession, async () => {
    events.push('second:start')
    const store = openCookieClearStore(targetSession)
    try {
      await store.writeCookieIdentity({
        url: 'https://recovered.example/',
        name: 'recovered',
        value: 'written-after-retirement',
        sameSite: 'unspecified',
        secure: true
      })
      events.push('second:done')
    } finally {
      store.dispose()
    }
  })

  mark('commands started')
  await Promise.all([first, second])
  mark('imports settled')

  const viewer = new BrowserWindow({
    show: false,
    webPreferences: { session: targetSession, sandbox: true, contextIsolation: true }
  })
  await viewer.loadURL('data:text/html,<title>cookie debugger verifier</title>')
  const viewerDebugger = viewer.webContents.debugger
  viewerDebugger.attach('1.3')
  const cookies = (await viewerDebugger.sendCommand('Network.getAllCookies')).cookies
  const recoveredCookieValues = cookies
    .filter((cookie) => cookie.name === 'recovered')
    .map((cookie) => cookie.value)
  viewerDebugger.detach()
  viewer.destroy()
  keeper.destroy()

  clearTimeout(fixtureTimeout)
  writeFileSync(resultPath, JSON.stringify({ step, firstError, events, recoveredCookieValues }))
  app.exit(0)
}

run().catch((error) => {
  writeFileSync(resultPath, JSON.stringify({ step, events, error: String(error?.stack || error) }))
  app.exit(1)
})
`
}

async function runFixture(): Promise<FixtureResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-cookie-debugger-retirement-'))
  fixtureRoots.push(root)
  const bundleEntryPath = join(root, 'cookie-debugger-retirement.ts')
  const bundlePath = join(root, 'cookie-debugger-retirement.cjs')
  const fixturePath = join(root, 'main.cjs')
  const resultPath = join(root, 'result.json')
  writeFileSync(
    bundleEntryPath,
    [
      `export { openCookieClearStore } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-cookie-clear-store.ts'))}`,
      `export { sendCookieDebuggerCommand } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-cookie-debugger-command.ts'))}`,
      `export { withCookieMutationLock } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-cookie-import-clear.ts'))}`
    ].join('\n')
  )
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: bundleEntryPath,
        formats: ['cjs'],
        fileName: () => 'cookie-debugger-retirement.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, fixtureMain(bundlePath, resultPath))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const electronArgs = [fixturePath, `--user-data-dir=${join(root, 'profile')}`]
  const executable = process.platform === 'linux' ? 'xvfb-run' : electronBinary
  const args =
    process.platform === 'linux'
      ? ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox']
      : electronArgs
  const run = spawnSync(executable, args, { encoding: 'utf8', env, timeout: 60_000 })
  const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return JSON.parse(fixtureResult) as FixtureResult
}

describe('cookie debugger retirement in Electron', () => {
  it('settles the wedged command before a queued cookie mutation starts', async () => {
    const result = await runFixture()

    expect(result.step).toBe('imports settled')
    expect(result.firstError).toEqual({
      name: 'CookieDebuggerCommandTimeoutError',
      message: 'Cookie debugger command Runtime.evaluate timed out after 10000ms'
    })
    expect(result.events).toEqual([
      'first:start',
      'first:retire',
      'first:error',
      'second:start',
      'second:done'
    ])
    expect(result.recoveredCookieValues).toEqual(['written-after-retirement'])
  }, 60_000)
})
