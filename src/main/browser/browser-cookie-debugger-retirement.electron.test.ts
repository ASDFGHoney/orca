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
  secondError: { name: string; message: string } | null
  events: string[]
  recoveredCookieValues: string[]
}

function fixtureMain(bundlePath: string, resultPath: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const { openCookieClearStore, withCookieMutationLock } = require(${JSON.stringify(bundlePath)})
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
  let targetCount = 0
  let resolveOrphan = null
  app.on('web-contents-created', (_event, contents) => {
    targetCount += 1
    const label = String(targetCount)
    events.push('target:' + label + ':created')
    contents.once('destroyed', () => events.push('target:' + label + ':destroyed'))
    const sendCommand = contents.debugger.sendCommand.bind(contents.debugger)
    contents.debugger.sendCommand = (method, params) => {
      events.push('target:' + label + ':' + method)
      if (label === '1' && method === 'Network.setCookie') {
        return new Promise((resolve) => {
          resolveOrphan = () => {
            events.push('first:late-completion')
            resolve({ success: true })
          }
        })
      }
      return sendCommand(method, params)
    }
  })

  let firstError = null
  const first = withCookieMutationLock(targetSession, async () => {
    events.push('first:start')
    const store = openCookieClearStore(targetSession)
    try {
      await store.writeCookieIdentity({
        url: 'https://wedged.example/',
        name: 'wedged',
        value: 'never-committed',
        sameSite: 'unspecified',
        secure: true
      })
    } catch (error) {
      firstError = { name: error?.name || '', message: String(error?.message || error) }
      events.push('first:error')
    } finally {
      store.dispose()
    }
  })

  let secondError = null
  const second = withCookieMutationLock(targetSession, async () => {
    events.push('second:start')
  }).catch((error) => {
    secondError = { name: error?.name || '', message: String(error?.message || error) }
    events.push('second:error')
  })

  mark('commands started')
  await Promise.all([first, second])
  mark('quarantine proven')

  if (!resolveOrphan) throw new Error('the injected cookie command never started')
  resolveOrphan()
  await new Promise((resolve) => setImmediate(resolve))

  await withCookieMutationLock(targetSession, async () => {
    events.push('third:start')
    const store = openCookieClearStore(targetSession)
    try {
      await store.writeCookieIdentity({
        url: 'https://recovered.example/',
        name: 'recovered',
        value: 'written-after-quarantine',
        sameSite: 'unspecified',
        secure: true
      })
      events.push('third:done')
    } finally {
      store.dispose()
    }
  })

  const cookies = await targetSession.cookies.get({ name: 'recovered' })
  const recoveredCookieValues = cookies
    .filter((cookie) => cookie.name === 'recovered')
    .map((cookie) => cookie.value)
  keeper.destroy()

  clearTimeout(fixtureTimeout)
  writeFileSync(
    resultPath,
    JSON.stringify({ step, firstError, secondError, events, recoveredCookieValues })
  )
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
  it('quarantines an unsettled cookie command and recovers after its late completion', async () => {
    const result = await runFixture()

    expect(result.step).toBe('quarantine proven')
    expect(result.firstError).toEqual({
      name: 'CookieDebuggerCommandTimeoutError',
      message: 'Cookie debugger command Network.setCookie timed out after 10000ms'
    })
    expect(result.secondError).toEqual({
      name: 'CookieMutationQuarantinedError',
      message:
        'A previous cookie import is still finishing in Chromium. Wait a moment and try again; if it continues, restart Orca.'
    })
    expect(result.events).not.toContain('second:start')
    expect(result.events.indexOf('first:error')).toBeLessThan(
      result.events.indexOf('first:late-completion')
    )
    expect(result.events.indexOf('first:late-completion')).toBeLessThan(
      result.events.indexOf('third:start')
    )
    expect(result.events).toContain('target:1:Network.setCookie')
    expect(result.events).toContain('target:1:destroyed')
    expect(result.events).toContain('target:2:Network.setCookie')
    expect(result.events).toContain('third:done')
    expect(result.recoveredCookieValues).toEqual(['written-after-quarantine'])
  }, 60_000)
})
