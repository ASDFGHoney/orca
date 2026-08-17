import { describe, expect, it } from 'vitest'
import { createArtifactListVisualMock } from './artifact-list-visual-mock'

describe('artifact list visual mock', () => {
  it('includes html and markdown rows with mixed expiry', () => {
    const now = Date.parse('2026-08-15T12:00:00.000Z')
    const items = createArtifactListVisualMock(now)

    expect(items.length).toBeGreaterThanOrEqual(6)
    expect(items.some((item) => item.artifact.sourceContentType === 'text/html')).toBe(true)
    expect(items.some((item) => item.artifact.sourceContentType === 'text/markdown')).toBe(true)
    expect(items.some((item) => Date.parse(item.artifact.expiresAt) < now)).toBe(true)
    expect(items.every((item) => item.shareUrl.startsWith('https://'))).toBe(true)
    expect(new Set(items.map((item) => item.artifact.slug)).size).toBe(items.length)
  })
})
