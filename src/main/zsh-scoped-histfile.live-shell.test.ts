/**
 * Real-zsh proof that a worktree-scoped HISTFILE survives shell startup.
 *
 * macOS `/etc/zshrc` assigns `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` with no
 * check-before-set, and it runs before every wrapper file Orca controls. So the
 * value `injectHistoryEnv` put in the spawn env is already gone by the time the
 * user reaches a prompt — and because ZDOTDIR still points at Orca's wrapper
 * dir, the replacement lands inside it. Per-worktree history was therefore a
 * silent no-op on the primary platform (#11044).
 *
 * Only a real zsh can show this: the string the wrapper emits looks correct
 * either way, and the whole bug lives in what /etc/zshrc does between the spawn
 * env and the first prompt.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getRelayShellLaunchConfig } from '../relay/pty-shell-launch'
import { getHistoryRestoreShellLaunchConfig } from './providers/local-pty-shell-ready'
import { getZshShellReadyRcfileContent } from './providers/local-pty-shell-ready-wrapper-generation'
import { requiresZshHistoryRestoreWrapper } from './pty/zsh-history-restore-wrapper'
import { getZshEnvTemplate, ZSH_HISTFILE_RESTORE_BLOCK } from './shell-templates'

// Why probe and execute the same binary: guarding on `zsh` from PATH but then
// running a hardcoded `/bin/zsh` lets the guard pass on a host that installs zsh
// elsewhere, and the test fails for a missing binary rather than a wrapper
// defect. The absolute path is resolved once so the sandboxed PATH below cannot
// lose it.
const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const ZSH_PATH = hasZsh
  ? (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout || '').trim()
  : ''
const itWithZsh = hasZsh ? it : it.skip

/**
 * Whether this host's system zsh startup files actually clobber an injected
 * HISTFILE.
 *
 * Why probed instead of assumed: that clobber is the entire premise of the
 * `RESULT=<scoped>` cases. macOS `/etc/zshrc` always does it; a stock Linux
 * image usually has no such assignment, so there an unwrapped zsh returns the
 * injected value too and those cases would pass with the wrapper removed. Skip
 * rather than assert, so Linux CI reports "not applicable" instead of green.
 */
function systemZshClobbersInjectedHistfile(): boolean {
  const home = mkdtempSync(join(tmpdir(), 'orca-histfile-clobber-probe-'))
  try {
    const probe = join(home, 'injected', 'zsh_history')
    const output = execFileSync(ZSH_PATH, ['-li', '-c', 'echo "RESULT=$HISTFILE"'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', HOME: home, HISTFILE: probe }
    })
    return !output.includes(`RESULT=${probe}`)
  } catch {
    return false
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const itWithHistfileClobber = hasZsh && systemZshClobbersInjectedHistfile() ? it : it.skip

function runLoginZsh(home: string, zdotdir: string, env: Record<string, string>): string {
  // -o noglobalrcs is deliberately NOT passed: /etc/zshrc is the thing under test.
  return execFileSync(ZSH_PATH, ['-li', '-c', 'echo "RESULT=$HISTFILE"'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      ZDOTDIR: zdotdir,
      ORCA_ORIG_ZDOTDIR: home,
      ORCA_ZSHENV_SOURCE_DIR: home,
      ...env
    }
  })
}

describe('worktree-scoped HISTFILE survives zsh startup', () => {
  const withWrapper = (run: (home: string, zdotdir: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), 'orca-scoped-histfile-'))
    const zdotdir = join(home, 'shell-ready', 'zsh')
    mkdirSync(zdotdir, { recursive: true })
    writeFileSync(join(zdotdir, '.zshenv'), getZshEnvTemplate(zdotdir))
    writeFileSync(join(zdotdir, '.zshrc'), getZshShellReadyRcfileContent())
    writeFileSync(join(zdotdir, '.zlogin'), `${ZSH_HISTFILE_RESTORE_BLOCK}\n`)
    try {
      run(home, zdotdir)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  itWithHistfileClobber('keeps the injected path that a system zshrc would otherwise clobber', () => {
    withWrapper((home, zdotdir) => {
      const scoped = join(home, 'orca-history', 'zsh_history')

      const output = runLoginZsh(home, zdotdir, { HISTFILE: scoped, ORCA_HISTFILE: scoped })

      expect(output).toContain(`RESULT=${scoped}`)
    })
  })

  itWithHistfileClobber('never leaves history inside Orca’s own wrapper directory', () => {
    withWrapper((home, zdotdir) => {
      const scoped = join(home, 'orca-history', 'zsh_history')

      const output = runLoginZsh(home, zdotdir, { HISTFILE: scoped, ORCA_HISTFILE: scoped })

      // The exact failure mode of #11044: history written into shell-ready/zsh.
      expect(output).not.toContain(zdotdir)
    })
  })

  itWithZsh('leaves HISTFILE exactly as an unwrapped zsh would when Orca injects nothing', () => {
    // Why compared against an unwrapped run rather than asserted non-empty: what
    // zsh defaults to is platform-specific. macOS `/etc/zshrc` assigns HISTFILE,
    // so it is always set there; a stock Ubuntu zsh has no such file and leaves
    // it EMPTY. The contract is that Orca's wrapper does not change it either
    // way, which is the same assertion on both.
    withWrapper((home, zdotdir) => {
      const wrapped = runLoginZsh(home, zdotdir, {})
      const unwrapped = execFileSync(ZSH_PATH, ['-li', '-c', 'echo "RESULT=$HISTFILE"'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: '/usr/bin:/bin', HOME: home }
      })

      const histfileOf = (output: string): string =>
        /^RESULT=(.*)$/m.exec(output)?.[1]?.trim() ?? '<unmatched>'
      expect(histfileOf(wrapped)).toBe(histfileOf(unwrapped))
      expect(wrapped).not.toContain('ORCA_HISTFILE')
    })
  })
})

/**
 * The cases above pre-write the wrapper ZDOTDIR by hand, so they can only prove
 * the wrapper CONTENT is right. These build the launch config through the real
 * config functions the desktop and relay call for a plain pane — no startup
 * command, no Codex/OpenCode overlay, nothing but a scoped history — and hand
 * exactly that args/env pair to a real zsh.
 *
 * What they deliberately do NOT do is run LocalPtyProvider.spawn: which panes
 * reach these functions is unit-covered in local-pty-provider-spawn-env.test.ts
 * (and pty-subprocess-managed-agent-env.test.ts for the daemon). Only a live
 * shell can show the other half — that the config those gates apply survives
 * /etc/zshrc, and that a history-only wrapper stays out of the command
 * lifecycle the pane had while it launched unwrapped.
 */
describe('a plain pane reaches zsh with the wrapper its launch config describes', () => {
  const withSandboxedHome = (run: (home: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), 'orca-plain-pane-histfile-'))
    const saved = {
      HOME: process.env.HOME,
      ZDOTDIR: process.env.ZDOTDIR,
      ORCA_ORIG_ZDOTDIR: process.env.ORCA_ORIG_ZDOTDIR,
      ORCA_USER_DATA_PATH: process.env.ORCA_USER_DATA_PATH
    }
    // Why: the desktop launch config resolves the user's real ZDOTDIR/HOME from
    // this process, and would otherwise source the developer's own zsh config.
    process.env.HOME = home
    delete process.env.ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    process.env.ORCA_USER_DATA_PATH = home
    try {
      run(home)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      rmSync(home, { recursive: true, force: true })
    }
  }

  // Why `-i` on top of the config's args: a pane is interactive, and zsh only
  // sources .zshrc (where the restore lives) for interactive shells.
  function runLaunchedZsh(
    home: string,
    launchArgs: string[],
    env: Record<string, string>
  ): string {
    return execFileSync(
      ZSH_PATH,
      [
        ...launchArgs,
        '-i',
        '-c',
        'echo "RESULT=$HISTFILE"; echo "PRECMD=$precmd_functions"; echo "MARKERS=${ORCA_SHELL_COMMAND_MARKERS-unset}"'
      ],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: '/usr/bin:/bin', HOME: home, ...env }
      }
    )
  }

  itWithHistfileClobber('keeps the scoped HISTFILE for a local plain pane', () => {
    withSandboxedHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const spawnEnv = { HISTFILE: scoped, ORCA_HISTFILE: scoped }

      // No overlay env and no startup command, so the scoped history is the only
      // thing that can ask for a wrapper — otherwise the plain login shell.
      const launch = requiresZshHistoryRestoreWrapper(ZSH_PATH, spawnEnv)
        ? getHistoryRestoreShellLaunchConfig(ZSH_PATH)
        : { args: ['-l'], env: {} }
      const output = runLaunchedZsh(home, launch.args ?? ['-l'], { ...spawnEnv, ...launch.env })

      expect(output).toContain(`RESULT=${scoped}`)
    })
  })

  itWithZsh('keeps a history-only pane out of OSC 133, without leaking that to children', () => {
    withSandboxedHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const spawnEnv = { HISTFILE: scoped, ORCA_HISTFILE: scoped }

      const launch = getHistoryRestoreShellLaunchConfig(ZSH_PATH)
      const output = runLaunchedZsh(home, launch.args ?? ['-l'], { ...spawnEnv, ...launch.env })

      // Wrapping for history alone must not enroll the pane in OSC 133: it emitted
      // no command markers while it launched unwrapped, and every consumer of them
      // (agent-status drops, git-status refresh) would start firing per command.
      expect(output).not.toContain('__orca_osc133_precmd')
      // ...and the suppression must not outlive the wrapper. It is exported, so a
      // `pn dev`/CLI run started here would hand its `0` to the new Orca, whose
      // every overlay and startup pane would then go silent instead.
      expect(output).toContain('MARKERS=unset')
    })
  })

  itWithHistfileClobber('keeps the scoped HISTFILE for a relay plain pane', () => {
    withSandboxedHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const spawnEnv = { HOME: home, HISTFILE: scoped, ORCA_HISTFILE: scoped }

      const launch = getRelayShellLaunchConfig(ZSH_PATH, spawnEnv, process.platform)
      const output = runLaunchedZsh(home, launch.args, { ...spawnEnv, ...launch.env })

      expect(launch.args).toEqual(['-l'])
      expect(output).toContain(`RESULT=${scoped}`)
    })
  })
})
