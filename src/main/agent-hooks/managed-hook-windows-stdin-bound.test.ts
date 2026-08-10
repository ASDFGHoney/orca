// Why (#13285): pin the Windows stdin stall contracts — host timeout near the curl
// budget, missing-env exit without more.com, Devin drain that still honors #8419,
// curl form + payload@- endpoint path, and cleanup/exit fidelity.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})

import {
  MANAGED_HOOK_TIMEOUT_MILLISECONDS,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  WINDOWS_CLAUDE_HOOK_TIMEOUT_SECONDS,
  buildWindowsAgentHookCurlPostCommand,
  buildWindowsAgentHookPostCommand
} from './installer-utils'
import {
  WINDOWS_HOOK_STDIN_DRAIN_COMMAND,
  WINDOWS_HOOK_STDIN_DRAIN_LABEL,
  WINDOWS_HOOK_STDIN_READER,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from './hook-stdin-contract'
import { ClaudeHookService } from '../claude/hook-service'

describe('Windows managed-hook stdin bound (#13285)', () => {
  afterEach(() => {
    homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
  })

  it('limits only local Windows Claude hooks while preserving the global provider budget', () => {
    expect(WINDOWS_CLAUDE_HOOK_TIMEOUT_SECONDS).toBe(2)
    expect(MANAGED_HOOK_TIMEOUT_SECONDS).toBe(10)
    expect(MANAGED_HOOK_TIMEOUT_MILLISECONDS).toBe(10_000)
  })

  it('exits missing-Orca-env guards without entering the more.com drain', () => {
    const guards = buildWindowsHookEnvironmentGuardLines().join('\n')
    expect(guards).toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0')
    expect(guards).toContain('if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0')
    expect(guards).toContain('if "%ORCA_PANE_KEY%"=="" exit /b 0')
    expect(guards).not.toContain(`goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`)
    expect(guards).not.toContain(WINDOWS_HOOK_STDIN_READER)
  })

  it('preserves the #8419 more.com drain for reachable early-exit labels', () => {
    // Why: curl -T - to a dead port EPIPEs large writers; more.com is the full-drain primitive.
    expect(WINDOWS_HOOK_STDIN_DRAIN_COMMAND).toBe(`${WINDOWS_HOOK_STDIN_READER} >nul 2>nul`)
    expect(WINDOWS_HOOK_STDIN_READER).toContain('more.com')
    const epilogue = buildWindowsHookStdinDrainEpilogue().join('\r\n')
    expect(epilogue).toBe(
      [`:${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`, WINDOWS_HOOK_STDIN_DRAIN_COMMAND, 'exit /b 0'].join(
        '\r\n'
      )
    )
  })

  it('keeps the curl endpoint path on payload@- with connect/max-time bounds (not PowerShell)', () => {
    for (const command of [
      buildWindowsAgentHookPostCommand('claude'),
      buildWindowsAgentHookCurlPostCommand('claude'),
      buildWindowsAgentHookPostCommand('codex'),
      buildWindowsAgentHookCurlPostCommand('codex')
    ]) {
      expect(command).toContain('%SystemRoot%\\System32\\curl.exe')
      expect(command).toContain('--connect-timeout 0.5 --max-time 1.5')
      expect(command).toContain('--data-urlencode "payload@-"')
      expect(command).toContain('--data-urlencode "paneKey=%ORCA_PANE_KEY%"')
      expect(command).toContain('X-Orca-Agent-Hook-Token')
      expect(command).not.toMatch(/powershell/i)
      expect(command).not.toContain('Invoke-WebRequest')
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'installs Windows scripts with success, missing-env exit, Devin drain, curl path, and cleanup',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-13285-windows-stdin-'))
      const previousGrokHome = process.env.GROK_HOME
      process.env.GROK_HOME = join(home, 'grok-home')
      homedirMock.mockReturnValue(home)
      try {
        expect(new ClaudeHookService().install().state).toBe('installed')

        const hooksDir = join(home, '.orca', 'agent-hooks')
        const claude = readFileSync(join(hooksDir, 'claude-hook.cmd'), 'utf8')
        const collectTimeouts = (value: unknown, scriptName: string): number[] => {
          if (Array.isArray(value)) {
            return value.flatMap((entry) => collectTimeouts(entry, scriptName))
          }
          if (!value || typeof value !== 'object') {
            return []
          }
          const record = value as Record<string, unknown>
          const own =
            typeof record.command === 'string' &&
            record.command.includes(scriptName) &&
            typeof record.timeout === 'number'
              ? [record.timeout]
              : []
          return own.concat(
            Object.values(record).flatMap((entry) => collectTimeouts(entry, scriptName))
          )
        }
        const readTimeouts = (configPath: string, scriptName: string): number[] =>
          collectTimeouts(JSON.parse(readFileSync(configPath, 'utf8')), scriptName)
        expect(readTimeouts(join(home, '.claude', 'settings.json'), 'claude-hook.cmd')).toEqual(
          Array(11).fill(WINDOWS_CLAUDE_HOOK_TIMEOUT_SECONDS)
        )
        // Success / curl endpoint path
        expect(claude).toContain('--data-urlencode "payload@-"')
        expect(claude).toContain('--connect-timeout 0.5 --max-time 1.5')
        expect(claude).toContain('/hook/claude')
        expect(claude).toContain('X-Orca-Agent-Hook-Token')
        // Missing env: exit without drain
        expect(claude).toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0')
        expect(claude).not.toMatch(/ORCA_[A-Z_]+.*goto :?orca_agent_hook_drain_stdin/)
        // Devin skip still drains (held-open bounded by host timeout only)
        expect(claude).toContain(
          `if not "%DEVIN_PROJECT_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`
        )
        expect(claude.indexOf('if "%ORCA_PANE_KEY%"=="" exit /b 0')).toBeLessThan(
          claude.indexOf(`if not "%DEVIN_PROJECT_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`)
        )
        // Cleanup
        expect(claude).toContain(`:${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`)
        expect(claude).toContain(WINDOWS_HOOK_STDIN_DRAIN_COMMAND)
        expect(claude).toMatch(/exit \/b 0/)

        for (const fileName of readdirSync(hooksDir).filter((name) => name.endsWith('-hook.cmd'))) {
          const script = readFileSync(join(hooksDir, fileName), 'utf8')
          expect(script, `${fileName} missing-env port exit`).toContain(
            'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0'
          )
          expect(script, `${fileName} no PowerShell`).not.toMatch(/powershell/i)
        }
      } finally {
        if (previousGrokHome === undefined) {
          delete process.env.GROK_HOME
        } else {
          process.env.GROK_HOME = previousGrokHome
        }
        homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})
