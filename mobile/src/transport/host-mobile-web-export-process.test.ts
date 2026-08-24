import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostMobileWebExportProcessSpec,
  runHostMobileWebExport
} from '../../scripts/export-host-mobile-web.mjs'
import { resolveSpawn } from '../../../src/shared/child-process/run-process'

describe('host mobile web export process', () => {
  it('keeps adversarial Windows output argv inside the shared cmd boundary', () => {
    const outputDirectory =
      'C:\\exports\\space & pipe| redirect<out> percent%PATH% bang! caret^ quote" trail\\'
    const spec = createHostMobileWebExportProcessSpec({
      environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      mobileDirectory: 'C:\\Orca Workspace',
      outputDirectory,
      platform: 'win32'
    })
    const resolved = resolveSpawn(spec, 'win32')

    expect(spec.args.at(-1)).toBe(outputDirectory)
    expect(resolved.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(resolved.options).toMatchObject({
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true
    })
    expect(resolved.args).toHaveLength(1)
    expect(resolved.args[0]).toContain('"^%"PATH"^%"')
    expectCmdOperatorsQuoted(resolved.args[0]!)
  })

  it('returns the child exit code unchanged', async () => {
    const child = new EventEmitter()
    const pending = runHostMobileWebExport({
      outputDirectory: '/tmp/export',
      spawn: vi.fn(() => child)
    })

    child.emit('exit', 23, null)

    await expect(pending).resolves.toBe(23)
  })

  it('maps a child signal to failure and reports the signal', async () => {
    const child = new EventEmitter()
    const stderr = { write: vi.fn() }
    const pending = runHostMobileWebExport({
      outputDirectory: '/tmp/export',
      spawn: vi.fn(() => child),
      stderr
    })

    child.emit('exit', null, 'SIGTERM')

    await expect(pending).resolves.toBe(1)
    expect(stderr.write).toHaveBeenCalledWith('Expo web export terminated by SIGTERM\n')
  })
})

function expectCmdOperatorsQuoted(commandLine: string): void {
  const body = commandLine.slice('/d /v:off /s /c "'.length, -1)
  let quoted = false
  for (const character of body) {
    if (character === '"') {
      quoted = !quoted
    } else if ('&|<>'.includes(character)) {
      expect(quoted, `bare ${character} would be parsed as a cmd operator`).toBe(true)
    }
  }
  expect(quoted).toBe(false)
}
