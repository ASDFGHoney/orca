import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { WindowsConptyProcessMembershipReader } from './windows-conpty-process-membership'

const ptys: IPty[] = []
const detachedPids: number[] = []

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
  it('keeps results console-scoped across attached and detached children', async () => {
    const nodePty = await import('node-pty')
    const pty = nodePty.spawn('cmd.exe', ['/q', '/d'], {
      cols: 120,
      cwd: process.cwd(),
      env: process.env,
      name: 'xterm-256color',
      rows: 24
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
    const reader = new WindowsConptyProcessMembershipReader()

    try {
      const processIds = await reader.read(pty.pid)

      expect(processIds).not.toBeNull()
      expect(processIds).toContain(pty.pid)
      expect(processIds).toContain(attachedPid)
      expect(processIds).not.toContain(detachedPid)
    } finally {
      reader.dispose()
    }
  }, 15_000)
})

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
