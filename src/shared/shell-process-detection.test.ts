import { describe, expect, it } from 'vitest'

import { isShellProcess } from './shell-process-detection'

describe('isShellProcess', () => {
  it.each(['ksh', 'mksh', 'dash', 'ash', 'tcsh', 'csh', 'elvish', 'xonsh'])(
    'recognizes %s directly and through platform paths',
    (shell) => {
      expect(isShellProcess(shell)).toBe(true)
      expect(isShellProcess(`/usr/local/bin/${shell}`)).toBe(true)
      expect(isShellProcess(`C:\\shells\\${shell}.exe`)).toBe(true)
    }
  )

  it('does not classify an unknown foreground process as a shell', () => {
    expect(isShellProcess('node')).toBe(false)
  })

  it.each(['', '/'])('does not classify %j as a shell', (processName) => {
    expect(isShellProcess(processName)).toBe(false)
  })
})
