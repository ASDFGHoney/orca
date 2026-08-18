import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

import { forceStopRelayForTarget } from './ssh-relay-reset'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import type { SshConnection } from './ssh-connection'

const TARGET_PID = '11111'
const UNRELATED_PID = '22222'

/** How the sandboxed host behaves while the reset script runs. */
type HostMode = 'lsof-finds-owner' | 'only-pgrep-finds-owner' | 'kill-refused' | 'no-process-tools'

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

type ResetRun = {
  killCalls: string[]
  pgrepCalls: string[]
  socketExists: boolean
  error: Error | null
}

/**
 * Run the real reset script against a sandboxed host.
 *
 * Why a live socket and stubbed tools: the script's whole job is deciding whether the
 * owner is gone, so the stubs model an owner that stops answering only once `kill`
 * reaches it — a stub that always reports the pid would hide the post-kill re-check.
 */
async function runReset(mode: HostMode): Promise<ResetRun> {
  const home = mkdtempSync(join(tmpdir(), 'orca-'))
  const binDir = join(home, 'bin')
  const socketDir = join(home, '.orca-remote')
  const socketPath = join(socketDir, relaySocketNameForInstanceId('ssh-1'))
  const killLog = join(home, 'kill.log')
  const pgrepLog = join(home, 'pgrep.log')
  const holderFile = join(home, 'holder')
  mkdirSync(binDir)
  mkdirSync(socketDir, { recursive: true })
  writeFileSync(killLog, '')
  writeFileSync(pgrepLog, '')
  writeFileSync(holderFile, TARGET_PID)

  if (mode !== 'no-process-tools') {
    // Why the -a split: without it lsof would also return an unrelated Unix-socket holder,
    // which reset must never pass to kill (#8762).
    const lsofBody =
      mode === 'only-pgrep-finds-owner'
        ? 'exit 1'
        : `[ -s "$HOLDER_FILE" ] || exit 1
case " $* " in
  *" -a "*) printf '%s\\n' "$TARGET_PID" ;;
  *) printf '%s\\n' "$TARGET_PID" "$UNRELATED_PID" ;;
esac`
    writeExecutable(join(binDir, 'lsof'), lsofBody)
    writeExecutable(
      join(binDir, 'pgrep'),
      `printf 'called\\n' >> "$PGREP_LOG"
[ -s "$HOLDER_FILE" ] || exit 1
printf '%s\\n' "$TARGET_PID"`
    )
  }
  writeExecutable(join(binDir, 'sleep'), 'exit 0')

  const killBody =
    mode === 'kill-refused'
      ? `kill() { printf '%s\\n' "$*" >> "$KILL_LOG"; }`
      : `kill() { printf '%s\\n' "$*" >> "$KILL_LOG"; : > "$HOLDER_FILE"; }`

  const server = createServer()
  let error: Error | null = null
  try {
    await listenOnSocket(server, socketPath)
    vi.mocked(execCommand).mockImplementation((_conn, script) =>
      Promise.resolve(
        execFileSync('/bin/sh', ['-c', `${killBody}\neval "$RESET_SCRIPT"`], {
          env: {
            ...process.env,
            HOME: home,
            HOLDER_FILE: holderFile,
            KILL_LOG: killLog,
            PATH:
              mode === 'no-process-tools'
                ? binDir
                : `${binDir}${delimiter}${process.env.PATH ?? ''}`,
            PGREP_LOG: pgrepLog,
            RESET_SCRIPT: script,
            TARGET_PID,
            UNRELATED_PID
          }
        }).toString()
      )
    )
    await forceStopRelayForTarget({} as SshConnection, 'ssh-1').catch((err) => {
      error = err as Error
    })
    return {
      killCalls: readFileSync(killLog, 'utf8').split('\n').filter(Boolean),
      pgrepCalls: readFileSync(pgrepLog, 'utf8').split('\n').filter(Boolean),
      socketExists: existsSync(socketPath),
      error
    }
  } finally {
    await closeServer(server)
    rmSync(home, { recursive: true, force: true })
  }
}

describe('forceStopRelayForTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockResolvedValue('')
  })

  it('targets only the relay socket for the requested SSH target', async () => {
    const conn = {} as SshConnection

    await forceStopRelayForTarget(conn, 'ssh-1')

    const command = vi.mocked(execCommand).mock.calls[0]?.[1] ?? ''
    expect(execCommand).toHaveBeenCalledWith(conn, expect.any(String))
    expect(command).toContain(`sock_name='${relaySocketNameForInstanceId('ssh-1')}'`)
    expect(command).toContain('lsof -t -a -U "$1"')
    expect(command).toContain('pgrep -f "$sock_name"')
    expect(command).toContain('rm -f "$sock"')
  })

  it.skipIf(process.platform === 'win32')(
    'never passes unrelated unix-socket holders to kill',
    async () => {
      const result = await runReset('lsof-finds-owner')

      expect(result.killCalls).toEqual([`-TERM ${TARGET_PID}`, `-KILL ${TARGET_PID}`])
      expect(result.killCalls.join(' ')).not.toContain(UNRELATED_PID)
      // Why one call: the post-kill re-check finds lsof silent and falls through to pgrep.
      expect(result.pgrepCalls).toEqual(['called'])
      expect(result.socketExists).toBe(false)
      expect(result.error).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the command-line fallback when lsof cannot match the socket',
    async () => {
      const result = await runReset('only-pgrep-finds-owner')

      expect(result.killCalls).toEqual([`-TERM ${TARGET_PID}`, `-KILL ${TARGET_PID}`])
      // Why two calls: once to find the owner, once to prove it stopped answering.
      expect(result.pgrepCalls).toEqual(['called', 'called'])
      expect(result.socketExists).toBe(false)
      expect(result.error).toBeNull()
    }
  )

  // STA-1756: removing the socket of a relay that is still running does not stop it — it
  // strands it, which is the leak reset exists to clean up.
  it.skipIf(process.platform === 'win32')(
    'keeps the socket and reports failure when the owner survives the kill',
    async () => {
      const result = await runReset('kill-refused')

      expect(result.killCalls).toEqual([`-TERM ${TARGET_PID}`, `-KILL ${TARGET_PID}`])
      expect(result.socketExists).toBe(true)
      expect(result.error?.message).toContain('still running')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the socket and reports failure when the host cannot identify the owner',
    async () => {
      const result = await runReset('no-process-tools')

      expect(result.killCalls).toEqual([])
      expect(result.socketExists).toBe(true)
      expect(result.error?.message).toContain('neither lsof nor pgrep')
    }
  )
})
