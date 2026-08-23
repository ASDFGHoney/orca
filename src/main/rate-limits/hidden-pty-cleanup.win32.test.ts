import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHiddenRateLimitPty, windowsHiddenPtySpawnOptions } from './hidden-pty-cleanup'

const cleanupPids: number[] = []

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      // Process already exited.
    }
  }
})

describe.runIf(process.platform === 'win32')('Windows hidden PTY cleanup', () => {
  it('terminates attached and detached descendants through the PTY job owner', async () => {
    const nodePty = await import('node-pty')
    const spawnOptions = windowsHiddenPtySpawnOptions()
    expect(spawnOptions).toEqual({ useConptyDll: true })
    const term = nodePty.spawn('cmd.exe', ['/q', '/d'], {
      cols: 120,
      cwd: process.cwd(),
      env: process.env,
      name: 'xterm-256color',
      rows: 24,
      ...spawnOptions
    })
    cleanupPids.push(term.pid)
    const output = waitForOutput(term, /ATTACHED_PID=(\d+)\s+DETACHED_PID=(\d+)/)
    term.write(
      'powershell.exe -NoLogo -NoProfile -Command "$attached=$PID; ' +
        "$detached=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command'," +
        "'Start-Sleep -Seconds 30' -PassThru; Write-Output ATTACHED_PID=$attached; " +
        'Write-Output DETACHED_PID=$($detached.Id); Start-Sleep -Seconds 30"\r'
    )
    const match = await output
    const attachedPid = Number(match[1])
    const detachedPid = Number(match[2])
    cleanupPids.push(attachedPid, detachedPid)

    cleanupHiddenRateLimitPty(term, [], { kill: true })
    await Promise.all([
      waitForProcessExit(term.pid, 3_000),
      waitForProcessExit(attachedPid, 3_000),
      waitForProcessExit(detachedPid, 3_000)
    ])

    expect(isProcessAlive(term.pid)).toBe(false)
    expect(isProcessAlive(attachedPid)).toBe(false)
    expect(isProcessAlive(detachedPid)).toBe(false)
  }, 15_000)
})

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
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
