// @vitest-environment happy-dom
/**
 * The reporter's own string, `한글깨짐`, keystroke for keystroke as an iPad
 * produces it (#13345). Two properties are pinned here:
 *
 * - `깨` opens on `ㄲ`, a Shift-typed double consonant. Orca's own Shift rule
 *   (`xterm-bypass-policy.ts`) already hides those keydowns from xterm, so a fix
 *   living inside xterm's CompositionHelper never sees them and every syllable
 *   starting with one — 깨 꿈 딸 빵 쓰다 짜다 — stays broken. Sitting upstream of
 *   the bypass policy is what makes the source of the keydown irrelevant.
 * - Nothing is sent and then retracted. A field-diffing mirror emits one write
 *   per edit and erases the superseded syllable with DEL, which raw-mode TUIs
 *   need not read as "erase one cell" and which costs a round trip each over
 *   SSH or the relay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disposeOpenTerminals,
  dispatchKey,
  openIosTerminal,
  pretendIosWeb,
  typeJamo,
  type IosHangulRig
} from './terminal-ios-hangul-preedit-fixture'

/** The 18 field writes the device produces for `한글깨짐`, in order. */
const HANGUL_KKAEJIM_TRACE = [
  { key: 'ㅎ', written: 'ㅎ', replaces: false },
  { key: 'ㅏ', written: '하', replaces: true },
  { key: 'ㄴ', written: '한', replaces: true },
  { key: 'ㄱ', written: 'ㄱ', replaces: false },
  { key: 'ㅡ', written: '그', replaces: true },
  { key: 'ㄹ', written: '글', replaces: true },
  { key: 'ㄲ', written: 'ㄲ', replaces: false, shiftKey: true },
  { key: 'ㅐ', written: '깨', replaces: true },
  { key: 'ㅈ', written: 'ㅈ', replaces: false },
  { key: 'ㅣ', written: '지', replaces: true },
  { key: 'ㅁ', written: '짐', replaces: true }
] as const

async function replayTrace(rig: IosHangulRig): Promise<void> {
  for (const step of HANGUL_KKAEJIM_TRACE) {
    await typeJamo(rig, step.key, step.written, {
      replaces: step.replaces,
      shiftKey: 'shiftKey' in step ? step.shiftKey : false
    })
  }
}

describe('the recorded iPad device trace for 한글깨짐', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    disposeOpenTerminals()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('reaches the PTY as 한글깨짐', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await replayTrace(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted.join('')).toBe('한글깨짐\r')
  })

  it('writes once per syllable, so the 18 field edits are four PTY writes', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await replayTrace(rig)

    expect(rig.emitted).toEqual(['한', '글', '깨'])
    expect(rig.preedit.heldText()).toBe('짐')
  })

  it('puts no DEL or backspace byte on the wire', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await replayTrace(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    const wire = rig.emitted.join('')
    expect(wire).not.toContain('\x7f')
    expect(wire).not.toContain('\b')
  })

  it('composes a syllable-initial Shift+jamo with nothing before it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㄲ', 'ㄲ', { replaces: false, shiftKey: true })
    await typeJamo(rig, 'ㅐ', '깨', { replaces: true })
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted).toEqual(['깨', '\r'])
  })

  it('composes a mid-word Shift+jamo after a committed syllable', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    for (const step of HANGUL_KKAEJIM_TRACE.slice(0, 8)) {
      await typeJamo(rig, step.key, step.written, {
        replaces: step.replaces,
        shiftKey: 'shiftKey' in step ? step.shiftKey : false
      })
    }
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted.join('')).toBe('한글깨\r')
  })
})
