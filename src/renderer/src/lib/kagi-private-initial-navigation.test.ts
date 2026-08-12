import { describe, expect, it } from 'vitest'
import {
  discardKagiPrivateInitialNavigation,
  queueKagiPrivateInitialNavigation,
  takeKagiPrivateInitialNavigation
} from './kagi-private-initial-navigation'

describe('Kagi private initial navigation', () => {
  it('keeps the bearer URL separate from the browser model and consumes it once', () => {
    const modelUrl = 'https://kagi.com/search?q=private+project'
    const privateUrl = 'https://kagi.com/search?token=session-secret&q=private+project'

    queueKagiPrivateInitialNavigation('page-1', privateUrl)

    expect(takeKagiPrivateInitialNavigation('page-1', modelUrl)).toEqual({
      modelUrl,
      navigationUrl: privateUrl
    })
    expect(takeKagiPrivateInitialNavigation('page-1', modelUrl)).toEqual({
      modelUrl,
      navigationUrl: modelUrl
    })
  })

  it('survives delayed and high-volume tab mounting without evicting credentials', () => {
    const privateUrl = 'https://kagi.com/search?token=session-secret'
    for (let index = 0; index < 64; index += 1) {
      queueKagiPrivateInitialNavigation(`page-${index}`, `${privateUrl}-${index}`)
    }

    expect(takeKagiPrivateInitialNavigation('page-0', 'about:blank').navigationUrl).toBe(
      `${privateUrl}-0`
    )
    for (let index = 1; index < 64; index += 1) {
      discardKagiPrivateInitialNavigation(`page-${index}`)
    }
  })

  it('rejects non-Kagi URLs and discards closed pages', () => {
    expect(() =>
      queueKagiPrivateInitialNavigation('page-invalid', 'https://example.com/?token=secret')
    ).toThrow('Expected a Kagi private-session URL.')

    queueKagiPrivateInitialNavigation('page-closed', 'https://kagi.com/search?token=session-secret')
    discardKagiPrivateInitialNavigation('page-closed')

    expect(takeKagiPrivateInitialNavigation('page-closed', 'about:blank')).toEqual({
      modelUrl: 'about:blank',
      navigationUrl: 'about:blank'
    })
  })

  it('redacts a defensive model fallback without changing the private navigation', () => {
    const privateUrl = 'https://kagi.com/search?token=session-secret&q=private+project'

    expect(takeKagiPrivateInitialNavigation('page-missing', privateUrl)).toEqual({
      modelUrl: 'https://kagi.com/search?q=private+project',
      navigationUrl: privateUrl
    })
  })
})
