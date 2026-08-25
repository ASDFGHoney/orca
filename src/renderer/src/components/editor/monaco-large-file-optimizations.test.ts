import { describe, expect, it } from 'vitest'
import type { editor } from 'monaco-editor'
import { readMonacoLargeFileOptimizations } from './monaco-large-file-optimizations'

function modelReporting(value: unknown): editor.ITextModel {
  return { isTooLargeForTokenization: () => value } as unknown as editor.ITextModel
}

describe('readMonacoLargeFileOptimizations', () => {
  it('reports applied only when the model itself says so', () => {
    expect(readMonacoLargeFileOptimizations(modelReporting(true))).toBe('applied')
    expect(readMonacoLargeFileOptimizations(modelReporting(false))).toBe('not-applied')
  })

  // The flag is @internal in monaco's public typings, so a version bump can
  // remove it. "We could not read it" must never be reported as "off" — that
  // would make the notice claim features are intact when they may not be.
  it('reports unknown when the flag cannot be read', () => {
    expect(readMonacoLargeFileOptimizations(null)).toBe('unknown')
    expect(readMonacoLargeFileOptimizations({} as editor.ITextModel)).toBe('unknown')
    expect(readMonacoLargeFileOptimizations(modelReporting('yes'))).toBe('unknown')
    expect(
      readMonacoLargeFileOptimizations({
        isTooLargeForTokenization: () => {
          throw new Error('disposed')
        }
      } as unknown as editor.ITextModel)
    ).toBe('unknown')
  })
})
