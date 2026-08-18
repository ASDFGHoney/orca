import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const UNRELATED_PID = '22222'

// Why not plain `kill -0`: the owner is a child of this process, so between the signal and
// the event-loop turn that reaps it there is a zombie that `kill -0` still calls alive.
// Why the ladder rather than `ps`: a slim Linux image can ship without procps, and a stub
// that silently answered "gone" there would make these tests assert the wrong branch.
const OWNER_ALIVE_GUARD = `if [ -r /proc/"$OWNER_PID"/status ]; then
  grep -q '^State:.*Z' /proc/"$OWNER_PID"/status && exit 1
elif command -v ps >/dev/null 2>&1; then
  st=$(ps -p "$OWNER_PID" -o stat= 2>/dev/null | tr -d ' ')
  case "$st" in ""|Z*) exit 1 ;; esac
elif ! kill -0 "$OWNER_PID" 2>/dev/null; then
  exit 1
fi`

/** How the sandboxed host behaves while the reset script runs. */
type HostMode = 'lsof-finds-owner' | 'only-pgrep-finds-owner' | 'kill-refused' | 'no-process-tools'

function resolveTool(tool: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, tool)
    if (dir && existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** A real process holding a real Unix socket, so kill and the host's inventories agree. */
async function startSocketOwner(socketPath: string): Promise<ChildProcess> {
  const owner = spawn(
    process.execPath,
    [
      '-e',
      'require("net").createServer(()=>{}).listen(process.argv[1],()=>console.log("up"));' +
        'setInterval(()=>{},1000)',
      socketPath
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  await new Promise<void>((resolve, reject) => {
    owner.stdout?.once('data', () => resolve())
    owner.once('exit', () => reject(new Error('socket owner exited before listening')))
  })
  return owner
}

/** Wait on the child's own exit: the kill lands in a nested shell, so the parent needs a
 *  turn to reap it, and process.kill(pid, 0) answers true for the zombie in between. */
async function settleOwnerLiveness(owner: ChildProcess, timeoutMs = 3_000): Promise<boolean> {
  if (owner.exitCode !== null || owner.signalCode !== null) {
    return false
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      owner.off('exit', onExit)
      resolve(true)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    owner.once('exit', onExit)
  })
}

type ResetRun = {
  killCalls: string[]
  pgrepCalls: string[]
  socketExists: boolean
  ownerAlive: boolean
  error: Error | null
}

/**
 * Run the real reset script against a sandboxed host.
 *
 * Why a real owner process and a real kill: the script's job is deciding whether the owner
 * is gone, and on Linux it reads /proc/net/unix for that. Stubs answering from a flag file
 * would disagree with the kernel and make this test say different things on macOS and CI.
 */
async function runReset(mode: HostMode): Promise<ResetRun> {
  const home = mkdtempSync(join(tmpdir(), 'orca-'))
  const binDir = join(home, 'bin')
  const socketDir = join(home, '.orca-remote')
  const socketPath = join(socketDir, relaySocketNameForInstanceId('ssh-1'))
  const killLog = join(home, 'kill.log')
  const pgrepLog = join(home, 'pgrep.log')
  mkdirSync(binDir)
  mkdirSync(socketDir, { recursive: true })
  writeFileSync(killLog, '')
  writeFileSync(pgrepLog, '')

  const owner = await startSocketOwner(socketPath)
  const ownerPid = String(owner.pid)

  if (mode !== 'no-process-tools') {
    // Why the -a split: without it lsof would also return an unrelated Unix-socket holder,
    // which reset must never pass to kill (#8762).
    // Why the -p arm answers unconditionally: the script asks lsof about its own process
    // first to prove the tool works at all, and a stub that tied that to the socket's owner
    // would make a working lsof look broken the moment the relay stopped.
    const lsofSocketArm =
      mode === 'only-pgrep-finds-owner'
        ? 'exit 1'
        : `${OWNER_ALIVE_GUARD}
case " $* " in
  *" -a "*) printf '%s\\n' "$OWNER_PID" ;;
  *) printf '%s\\n' "$OWNER_PID" "$UNRELATED_PID" ;;
esac`
    const lsofBody = `case " $* " in
  *" -p "*) printf '%s\\n' "$$" ; exit 0 ;;
esac
${lsofSocketArm}`
    writeExecutable(join(binDir, 'lsof'), lsofBody)
    writeExecutable(
      join(binDir, 'pgrep'),
      `printf 'called\\n' >> "$PGREP_LOG"
${OWNER_ALIVE_GUARD}
printf '%s\\n' "$OWNER_PID"`
    )
  }
  // Why a real sleep: the script's post-kill re-check is only meaningful once the owner has
  // actually gone, and a no-op stub made it observe a process that was still dying.
  // Why link the ordinary utilities: the no-process-tools host is one without lsof and
  // pgrep, not one without a shell. Stripping PATH outright also removed awk and tr, and the
  // script then took a branch no real host takes.
  for (const tool of ['awk', 'sleep', 'tr']) {
    const resolved = resolveTool(tool)
    if (resolved) {
      writeExecutable(join(binDir, tool), `exec ${resolved} "$@"`)
    }
  }

  // Why a shell function: it records what reset asked for, and in the refused mode it lets
  // the owner survive the signal the way a permission error would.
  const killBody =
    mode === 'kill-refused'
      ? `kill() { printf '%s\\n' "$*" >> "$KILL_LOG"; }`
      : `kill() { printf '%s\\n' "$*" >> "$KILL_LOG"; command kill "$@" 2>/dev/null || true; }`

  let error: Error | null = null
  try {
    vi.mocked(execCommand).mockImplementation((_conn, script) =>
      Promise.resolve(
        execFileSync('/bin/sh', ['-c', `${killBody}\neval "$RESET_SCRIPT"`], {
          env: {
            ...process.env,
            HOME: home,
            KILL_LOG: killLog,
            OWNER_PID: ownerPid,
            PATH:
              mode === 'no-process-tools'
                ? binDir
                : `${binDir}${delimiter}${process.env.PATH ?? ''}`,
            PGREP_LOG: pgrepLog,
            RESET_SCRIPT: script,
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
      ownerAlive: await settleOwnerLiveness(owner),
      error
    }
  } finally {
    owner.kill('SIGKILL')
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
    expect(command).toContain('/proc/net/unix')
    // Why ENVIRON: awk expands escape sequences in a -v value, so a socket path holding a
    // backslash would never equal its own /proc/net/unix entry and a live owner would read
    // as absent. (The branch itself needs /proc, so it is exercised on Linux.)
    expect(command).toContain('ORCA_SOCKET_TARGET="$1" awk')
    expect(command).toContain('ENVIRON["ORCA_SOCKET_TARGET"]')
    expect(command).not.toContain('awk -v target')
    // Why not: a stopped relay unlinks its own socket, and one that was killed leaves an
    // inode the next deploy releases under its identity guard (STA-1756).
    expect(command).not.toContain('rm -f')
  })

  it.skipIf(process.platform === 'win32')(
    'never passes unrelated unix-socket holders to kill',
    async () => {
      const result = await runReset('lsof-finds-owner')

      expect(result.killCalls.join(' ')).toContain('-TERM')
      expect(result.killCalls.join(' ')).not.toContain(UNRELATED_PID)
      expect(result.ownerAlive).toBe(false)
      expect(result.error).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the command-line fallback when lsof cannot match the socket',
    async () => {
      const result = await runReset('only-pgrep-finds-owner')

      expect(result.pgrepCalls.length).toBeGreaterThan(0)
      expect(result.ownerAlive).toBe(false)
      expect(result.error).toBeNull()
    }
  )

  // STA-1756: removing the socket of a relay that is still running does not stop it — it
  // strands it, which is the leak reset exists to clean up.
  it.skipIf(process.platform === 'win32')(
    'keeps the socket and reports failure when the owner survives the kill',
    async () => {
      const result = await runReset('kill-refused')

      expect(result.killCalls.join(' ')).toContain('-TERM')
      expect(result.ownerAlive).toBe(true)
      expect(result.socketExists).toBe(true)
      expect(result.error?.message).toContain('still running')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the socket when it cannot identify the owner it failed to stop',
    async () => {
      const result = await runReset('no-process-tools')

      // Why no kill: with no way to name the owner there is nothing to signal. On Linux
      // /proc/net/unix still shows the socket is held; on hosts without it nothing does —
      // either way the only safe answer is to leave it alone and say so.
      expect(result.killCalls).toEqual([])
      expect(result.ownerAlive).toBe(true)
      expect(result.socketExists).toBe(true)
      expect(result.error?.message).toMatch(/still running|no way to see/)
    }
  )
})
