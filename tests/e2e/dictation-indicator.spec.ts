import { expect, test } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'

type MeterFixture = {
  level: number
  peak: number
  isSpeaking: boolean
  isClipping: boolean
  lastUpdatedAt: number
}

async function setDictationVisualState(
  page: Page,
  state: 'listening' | 'stopping',
  meter: MeterFixture,
  partialTranscript = ''
): Promise<void> {
  await page.evaluate(
    ({ dictationState, dictationMeter, transcript }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Expected the E2E store to be exposed')
      }
      store.setState({
        dictationState,
        dictationMeter,
        partialTranscript: transcript
      })
    },
    { dictationState: state, dictationMeter: meter, transcript: partialTranscript }
  )
}

async function pauseForRecordedProof(page: Page): Promise<void> {
  if (process.env.ORCA_E2E_RECORD_VIDEO === '1') {
    await page.waitForTimeout(700)
  }
}

test('dictation grapes react across the visible recording lifecycle', async ({ orcaPage }) => {
  const quiet = { level: 0, peak: 0, isSpeaking: false, isClipping: false, lastUpdatedAt: 1 }
  await setDictationVisualState(orcaPage, 'listening', quiet)

  const status = orcaPage.getByRole('status').filter({ has: orcaPage.getByText('Listening') })
  await expect(status).toBeVisible()
  await expect(status.getByTestId('dictation-grapes').locator('span')).toHaveCount(9)
  await expect(status.getByRole('button', { name: 'Stop dictation' })).toBeVisible()
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  await expect(status.getByTestId('dictation-grapes').locator('span').first()).toHaveCSS(
    'transition-property',
    'none'
  )
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  await pauseForRecordedProof(orcaPage)

  const speaking = {
    level: 0.76,
    peak: 0.84,
    isSpeaking: true,
    isClipping: false,
    lastUpdatedAt: 2
  }
  await setDictationVisualState(orcaPage, 'listening', speaking)
  await expect(orcaPage.getByRole('status').filter({ hasText: 'Speaking' })).toBeVisible()
  await pauseForRecordedProof(orcaPage)

  const clipping = { ...speaking, level: 1, peak: 1, isClipping: true, lastUpdatedAt: 3 }
  await setDictationVisualState(orcaPage, 'listening', clipping)
  const clippingStatus = orcaPage.getByRole('status').filter({ hasText: 'Too loud' })
  await expect(clippingStatus).toBeVisible()
  await expect(clippingStatus).toHaveClass(/text-destructive/)
  await pauseForRecordedProof(orcaPage)

  await setDictationVisualState(
    orcaPage,
    'listening',
    speaking,
    'The visualizer follows every word without covering the workspace.'
  )
  await expect(
    orcaPage.getByText('The visualizer follows every word without covering the workspace.')
  ).toBeVisible()
  await pauseForRecordedProof(orcaPage)

  await setDictationVisualState(orcaPage, 'stopping', quiet)
  const processing = orcaPage.getByRole('status').filter({ hasText: 'Processing…' })
  await expect(processing).toBeVisible()
  await expect(processing.getByRole('button', { name: 'Stop dictation' })).toHaveCount(0)
  await pauseForRecordedProof(orcaPage)
})
