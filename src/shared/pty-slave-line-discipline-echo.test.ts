import { describe, expect, it, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { createPtySlaveLineEditorProbe, readPtySlavePath } from './pty-slave-line-discipline-echo'

/** Replies to the next stty call with the given output, or an error when `output` is null. */
function answerStty(output: string | null): void {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(output === null ? new Error('stty: no such file') : null, output ?? '', '')
  })
}

const COOKED = 'speed 38400 baud;\nlflags: icanon isig iexten echo echoe echok echoctl\n'
const RAW = 'speed 38400 baud;\nlflags: -icanon -isig -iexten -echo -echoe -echok -echoctl\n'
const LINE_EDITOR = `${RAW}cchars: lnext = <undef>; min = 1; time = 0;\n`

beforeEach(() => {
  execFileMock.mockReset()
})

describe('readPtySlavePath', () => {
  it('reads node-pty ptsName and rejects every shape that is not a usable path', () => {
    expect(readPtySlavePath({ ptsName: '/dev/ttys048' })).toBe('/dev/ttys048')
    // A ConPTY terminal has no ptsName at all, and an empty one names no device.
    expect(readPtySlavePath({})).toBeUndefined()
    expect(readPtySlavePath({ ptsName: '' })).toBeUndefined()
    expect(readPtySlavePath({ ptsName: 12 })).toBeUndefined()
    expect(readPtySlavePath(undefined)).toBeUndefined()
    expect(readPtySlavePath(null)).toBeUndefined()
  })
})

describe('createPtySlaveLineEditorProbe', () => {
  it('requires raw quiet mode with the line editor disabling literal-next', async () => {
    const probe = createPtySlaveLineEditorProbe('/dev/ttys048', 'darwin')
    answerStty(LINE_EDITOR)
    await expect(probe?.()).resolves.toBe('line-editor')
    answerStty(`${RAW}cchars: lnext = ^V; min = 1; time = 0;\n`)
    await expect(probe?.()).resolves.toBe('other')
    answerStty(COOKED)
    await expect(probe?.()).resolves.toBe('other')
  })

  it('fails closed when the terminal state is incomplete', async () => {
    const probe = createPtySlaveLineEditorProbe('/dev/ttys048', 'darwin')
    answerStty('lflags: -echo\ncchars: lnext = <undef>;\n')
    await expect(probe?.()).resolves.toBe('unknown')
  })
})
