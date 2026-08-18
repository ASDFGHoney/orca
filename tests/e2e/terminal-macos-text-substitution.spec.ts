/**
 * Headless end-to-end coverage for macOS system text substitution reaching the terminal.
 *
 * This restores, as CDP-synthesised specs that run in the normal headless project, coverage two
 * `@headful` macOS-only specs used to carry before they were removed as collateral in
 * 17cfc968cf5. Those two depended on an accessibility grant, a live system input source and a
 * Swift helper, and one was gated behind an env var, so CI had no lane that ran either.
 *
 * They also covered less than their names suggest. One typed a period and a space under the Latin
 * source and a Hangul word plus a space under the Korean source and asserted that **nothing extra**
 * appeared — recon for a report that automatic period substitution corrupts terminal input, which
 * recorded the report's stated trigger not reproducing. The other explicitly "asserts
 * preconditions, not outcomes". Neither was a regression test.
 *
 * Two things are pinned here, and they are the same guarantee stated twice:
 *
 *  1. Typing that looks like it might attract a substitution does not attract one. A Hangul commit
 *     followed by a word-boundary space, and a Latin period followed by a space, each reach the pty
 *     as exactly what was typed.
 *  2. A substitution that really is delivered is **declined**. macOS automatic period substitution
 *     rewrites a trailing `" "` into `". "` on the second space, and it does reach a browser text
 *     field — the helper textarea is one. It reaches no reference terminal: four were checked on
 *     hardware and all four deliver two spaces, because none of them is a text view. So the
 *     terminal has to decline it explicitly, and the regression guarded is that the substituting
 *     keystroke used to produce no bytes at all, turning two spaces into one.
 *
 * Assertions are on the bytes the pty child receives, through the tty line discipline, because
 * that is the line the user ends up with.
 */ import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { readTerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'
import {
  commitImeText,
  dispatchImeProcessKey,
  dispatchImeRewrittenPrintableKey,
  dispatchPlainEnter,
  dispatchRetroactiveTextReplacement,
  setImeComposition,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { applyImePlatformPolicy, expectImePlatformPolicy } from './terminal-ime-platform-policy'

const SPACE: ImeKeyIdentity = { key: ' ', code: 'Space', keyCode: 32 }
const PERIOD: ImeKeyIdentity = { key: '.', code: 'Period', keyCode: 190 }

/** macOS virtual key codes the removed spec typed, in the identities Chromium reports for them. */
const KEY_A: ImeKeyIdentity = { key: 'a', code: 'KeyA', keyCode: 65 }
const KEY_B: ImeKeyIdentity = { key: 'b', code: 'KeyB', keyCode: 66 }

test.describe('Terminal macOS text substitution', () => {
  test('sends a Hangul commit and its word-boundary space with nothing added', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    // The removed spec's Korean arm: 2-Set d+k composes 아, then Space separates the word. It ran
    // with NSAutomaticPeriodSubstitutionEnabled on and recorded `아 ` — one space, no period. The
    // guard is that the terminal adds nothing of its own at a word boundary.
    await applyImePlatformPolicy(orcaPage, 'mac')
    await expectImePlatformPolicy(orcaPage, 'mac')
    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
      for (const frame of ['ㅇ', '아']) {
        await dispatchImeProcessKey(arena.session, { key: 'Process', code: 'KeyD' })
        await setImeComposition(arena.session, frame)
      }
      await commitImeText(arena.session, '아')
      await orcaPage.waitForTimeout(60)
      await dispatchImeRewrittenPrintableKey(arena.session, SPACE)
      await orcaPage.waitForTimeout(60)
      await dispatchPlainEnter(arena.session)

      expect((await readTerminalImeBoundaryTrace(orcaPage)).onData.join('')).toBe('아 \r')
      expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
        Buffer.from('아 \n').toString('hex')
      ])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'hangul-word-boundary-space', !completed)
      removeTerminalImeByteReader(reader)
    }
  })

  test('sends a Latin period and space with nothing added', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    // The removed spec's ABC arm. A period immediately before a space is the position automatic
    // period substitution acts on, so this is the paired control: with no second space there is
    // nothing to substitute and the terminal must send exactly the two characters typed.
    await applyImePlatformPolicy(orcaPage, 'mac')
    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
      for (const identity of [PERIOD, SPACE]) {
        await dispatchImeRewrittenPrintableKey(arena.session, identity)
        await orcaPage.waitForTimeout(60)
      }
      await dispatchPlainEnter(arena.session)

      expect((await readTerminalImeBoundaryTrace(orcaPage)).onData.join('')).toBe('. \r')
      expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
        Buffer.from('. \n').toString('hex')
      ])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'latin-period-space', !completed)
      removeTerminalImeByteReader(reader)
    }
  })

  test('declines an automatic period substitution and sends both spaces', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    // Declined, not honoured. Four reference terminals were checked on hardware and none of them
    // applies this substitution — they are not text views, so it never reaches them and two spaces
    // stay two spaces. A browser-based terminal does receive it, so it has to decline explicitly.
    // The regression guarded here is that the substituting keystroke used to produce no bytes at
    // all, turning two spaces into one.
    await applyImePlatformPolicy(orcaPage, 'mac')
    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
      for (const identity of [KEY_A, KEY_B, SPACE]) {
        await dispatchImeRewrittenPrintableKey(arena.session, identity)
        await orcaPage.waitForTimeout(60)
      }
      // The second Space produces no character of its own: the text system swallows it and
      // rewrites the trailing space into `. `.
      await arena.session.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: ' ',
        code: 'Space',
        windowsVirtualKeyCode: 32,
        nativeVirtualKeyCode: 32,
        text: '',
        unmodifiedText: ''
      })
      await dispatchRetroactiveTextReplacement(orcaPage, { deleteCount: 1, insertedText: '. ' })
      await orcaPage.waitForTimeout(60)
      await dispatchPlainEnter(arena.session)

      expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
        Buffer.from('ab  \n').toString('hex')
      ])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'automatic-period-substitution', !completed)
      removeTerminalImeByteReader(reader)
    }
  })
})
