import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import {
  EDITOR_TEXT_READ_LIMIT_BYTES,
  formatFileTooLargeMessage
} from '../../../../shared/editor-file-read-limit'

const tooLarge = `Error invoking remote method 'fs:readFile': Error: ${formatFileTooLargeMessage({
  byteLength: 53_477_376,
  limitBytes: EDITOR_TEXT_READ_LIMIT_BYTES.local,
  scope: 'local'
})}`

describe('EditorFileLoadErrorView', () => {
  it('degrades an oversized file to the explanatory fallback', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message={tooLarge}
        filePath="/repo/generated.json"
        onRetry={vi.fn()}
      />
    )

    expect(html).toContain('data-testid="large-file-fallback"')
    expect(html).toContain('/repo/generated.json')
    // Retry re-runs the same size check, so offering it is a guaranteed dead end.
    expect(html).not.toContain('Retry')
  })

  it('keeps the retryable error box for every other failure', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message="EACCES: permission denied"
        filePath="/repo/generated.json"
        onRetry={vi.fn()}
      />
    )

    expect(html).not.toContain('data-testid="large-file-fallback"')
    expect(html).toContain('Retry')
  })
})
