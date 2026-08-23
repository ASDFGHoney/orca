import { describe, expect, it } from 'vitest'
import { mobileNativeBaselineMode } from './mobile-native-baseline-mode'

describe('mobile native baseline mode', () => {
  it('requires the exact runner flag in a development build', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: '1' })).toBe(true)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: undefined })).toBe(false)
    expect(mobileNativeBaselineMode({ developmentBuild: true, requested: 'true' })).toBe(false)
  })

  it('cannot enable native workspace routes in production', () => {
    expect(mobileNativeBaselineMode({ developmentBuild: false, requested: '1' })).toBe(false)
  })
})
