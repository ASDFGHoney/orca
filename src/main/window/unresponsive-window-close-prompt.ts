import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'

export type UnresponsiveWindowCloseDecision = 'wait' | 'close'

/** Built per call: the locale can change after startup, and these strings are only read when the deadline fires. */
export function buildUnresponsiveWindowClosePromptOptions(): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: [
      translateMain('window.unresponsiveClose.wait', 'Wait'),
      translateMain('window.unresponsiveClose.close', 'Close Window')
    ],
    // Why: Wait is both default and cancel so a reflexive Enter/Escape can never be the answer that discards sessions (#5787).
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: translateMain('window.unresponsiveClose.title', 'Orca isn’t responding'),
    message: translateMain(
      'window.unresponsiveClose.message',
      'This Orca window didn’t respond to the close request.'
    ),
    detail: translateMain(
      'window.unresponsiveClose.detail',
      'Wait keeps the window open in case it recovers. Close Window ends this window’s terminal sessions and discards unsaved editor changes in it.'
    )
  }
}

/**
 * Asks the user what to do about a window whose renderer never acknowledged the
 * close request.
 *
 * Why: the main process owns this dialog because the renderer that would draw an
 * in-app one is the thing that is wedged. Only a user decision may end the
 * sessions — main silently deciding that is what #5787 forbids.
 */
export async function promptForUnresponsiveWindowClose(
  parentWindow?: BrowserWindow
): Promise<UnresponsiveWindowCloseDecision> {
  const options = buildUnresponsiveWindowClosePromptOptions()
  const result = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options)
  return result?.response === 1 ? 'close' : 'wait'
}
