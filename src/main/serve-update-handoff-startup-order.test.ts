import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('serve update handoff startup order', () => {
  it('installs app path ownership before resolving the supervised handoff path', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

    expect(source.indexOf('setAppEnvironment(new ElectronAppEnvironment())')).toBeGreaterThan(-1)
    expect(source.indexOf('installServeSupervisorDisconnectQuit(isServeMode)')).toBeGreaterThan(
      source.indexOf('setAppEnvironment(new ElectronAppEnvironment())')
    )
  })
})
