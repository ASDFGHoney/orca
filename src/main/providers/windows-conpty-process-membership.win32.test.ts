import type { IPty } from 'node-pty'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { readWindowsConptyProcessIds } from './windows-conpty-process-membership'

const ptys: IPty[] = []
const detachedPids: number[] = []
const require = createRequire(import.meta.url)

afterEach(() => {
  for (const pty of ptys.splice(0)) {
    pty.kill()
  }
  for (const pid of detachedPids.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      // Process already exited.
    }
  }
})

describe.runIf(process.platform === 'win32')('Windows ConPTY process membership', () => {
  it('fails closed for the bundled ConPTY production topology', async () => {
    const nodePty = await import('node-pty')
    const pty = nodePty.spawn('cmd.exe', ['/q', '/d'], {
      cols: 120,
      cwd: process.cwd(),
      env: process.env,
      name: 'xterm-256color',
      rows: 24,
      useConptyDll: true
    })
    ptys.push(pty)
    const output = waitForOutput(pty, /ATTACHED_PID=(\d+)\s+DETACHED_PID=(\d+)/)
    pty.write(
      'powershell.exe -NoLogo -NoProfile -Command "$attached=$PID; ' +
        "$detached=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command'," +
        "'Start-Sleep -Seconds 30' -PassThru; Write-Output ATTACHED_PID=$attached; " +
        'Write-Output DETACHED_PID=$($detached.Id); Start-Sleep -Seconds 30"\r'
    )
    const match = await output
    const attachedPid = Number(match[1])
    const detachedPid = Number(match[2])
    detachedPids.push(detachedPid)
    expect(attachedPid).toBeGreaterThan(0)
    expect(detachedPid).toBeGreaterThan(0)
    const bundledProbe = await readRawConsoleMembership(pty.pid)
    expect(bundledProbe.processIds).toContain(pty.pid)
    expect(bundledProbe.helperPid).toBeGreaterThan(0)
    await expect(readWindowsConptyProcessIds(pty.pid)).resolves.toBeNull()
  }, 15_000)

  it('proves the helper can join system ConPTY', async () => {
    const nodePty = await import('node-pty')
    const pty = nodePty.spawn('cmd.exe', ['/q', '/d'], {
      cols: 120,
      cwd: process.cwd(),
      env: process.env,
      name: 'xterm-256color',
      rows: 24
    })
    ptys.push(pty)

    const probe = await readRawConsoleMembership(pty.pid)
    expect(probe.processIds).toContain(pty.pid)
    expect(probe.processIds).toContain(probe.helperPid)
  }, 15_000)
})

function readRawConsoleMembership(
  rootPid: number
): Promise<{ helperPid: number; processIds: number[] }> {
  const agentPath = require.resolve('node-pty/lib/conpty_console_list_agent.js')
  const child = fork(agentPath, [String(rootPid)], { silent: true })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Timed out reading console membership for ${rootPid}`))
    }, 5_000)
    child.once('error', reject)
    child.once('message', (message: { consoleProcessList?: unknown }) => {
      clearTimeout(timeout)
      const processIds = message.consoleProcessList
      if (!child.pid || !Array.isArray(processIds)) {
        reject(new Error('Console-list helper returned malformed membership'))
        return
      }
      resolve({ helperPid: child.pid, processIds })
    })
  })
}

function waitForOutput(pty: IPty, pattern: RegExp): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      disposable.dispose()
      reject(new Error(`Timed out waiting for PTY output: ${output}`))
    }, 5_000)
    const disposable = pty.onData((data) => {
      output += data
      const match = output.match(pattern)
      if (!match) {
        return
      }
      clearTimeout(timeout)
      disposable.dispose()
      resolve(match)
    })
  })
}
