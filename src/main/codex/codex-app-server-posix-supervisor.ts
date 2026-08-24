import type { CodexAppServerLaunch } from './codex-app-server-connection'

/** Inline supervisor source kept dependency-free for the spawned Node child. */
export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const stream of [process.stdin, child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
const originalParent = process.ppid
const timer = setInterval(() => {
  if (process.ppid !== originalParent && process.ppid === 1) {
    try { process.kill(-process.pid, 'SIGKILL') } catch {}
  }
}, 100)
timer.unref()
child.once('error', () => {
  clearInterval(timer)
  process.exit(127)
})
child.once('exit', (code, signal) => {
  clearInterval(timer)
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
`

export function supervisedPosixLaunch(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  cwd = launch.cwd ?? process.cwd()
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      command: launch.command,
      args: launch.args,
      cwd,
      env: childEnv
    })
  ).toString('base64')
  return {
    command: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT],
    env: { ...childEnv, ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec }
  }
}

export function createProviderSpawnSpec(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { program: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; detached: boolean } {
  const supervised = platform === 'win32' ? null : supervisedPosixLaunch(launch, childEnv)
  return {
    program: supervised?.command ?? launch.command,
    args: supervised?.args ?? launch.args,
    env: supervised?.env ?? childEnv,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32'
  }
}
