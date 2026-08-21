import { describe, expect, it } from 'vitest'
import { resolveSpawn } from './run-process'
import { WINDOWS_ARGUMENT_CORPUS } from './windows-command-line-corpus'

const SPEC = { program: 'C:\\bin\\agent.cmd', args: ['--prompt', 'hi'] }

describe('resolveSpawn', () => {
  it('always hides the console and never uses a shell', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const resolved = resolveSpawn({ program: 'git', args: ['status'] }, platform)
      expect(resolved.options.windowsHide).toBe(true)
      expect(resolved.options.shell).toBe(false)
    }
  })

  it('spawns a non-cmd program directly, letting Node do the argv quoting', () => {
    // Node's own Windows quoting is already CommandLineToArgvW-correct for real
    // executables; re-implementing it here would add risk for no gain.
    const resolved = resolveSpawn({ program: 'C:\\bin\\agent.exe', args: ['a b'] }, 'win32')
    expect(resolved.file).toBe('C:\\bin\\agent.exe')
    expect(resolved.args).toEqual(['a b'])
    expect(resolved.options.windowsVerbatimArguments).toBeUndefined()
  })

  it('routes a .cmd target through cmd.exe with a verbatim line', () => {
    const resolved = resolveSpawn({ ...SPEC, env: { ComSpec: 'C:\\W\\cmd.exe' } }, 'win32')
    expect(resolved.file).toBe('C:\\W\\cmd.exe')
    expect(resolved.args).toHaveLength(1)
    expect(resolved.args[0]).toContain('/d /v:off /s /c')
    expect(resolved.options.windowsVerbatimArguments).toBe(true)
    expect(resolved.options.windowsHide).toBe(true)
  })

  it('treats a .cmd path as an ordinary program off Windows', () => {
    // A POSIX host running a file that happens to end in .cmd must not gain a
    // cmd.exe hop; the extension carries no meaning there.
    const resolved = resolveSpawn(SPEC, 'linux')
    expect(resolved.file).toBe(SPEC.program)
    expect(resolved.args).toEqual(SPEC.args)
  })

  it('never lets a corpus argument reach cmd as an operator', () => {
    for (const { name, value } of WINDOWS_ARGUMENT_CORPUS) {
      const line = resolveSpawn({ program: 'C:\\a.cmd', args: [value] }, 'win32').args[0]!
      const body = line.slice('/d /v:off /s /c "'.length, -1)
      // Every `&`/`|`/`<`/`>` must sit inside a quoted run. Walking the parity
      // is the same thing cmd does, so this is the property that matters.
      let quoted = false
      for (const char of body) {
        if (char === '"') {
          quoted = !quoted
          continue
        }
        if ('&|<>'.includes(char)) {
          expect(quoted, `${name}: bare ${char} would parse as a cmd operator`).toBe(true)
        }
      }
      expect(quoted, `${name}: line ends mid-quote`).toBe(false)
    }
  })
})
