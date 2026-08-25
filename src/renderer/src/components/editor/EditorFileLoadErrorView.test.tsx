// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'

afterEach(cleanup)

describe('EditorFileLoadErrorView', () => {
  it('explains an oversized file instead of reporting a load failure', () => {
    render(
      <EditorFileLoadErrorView
        message="Error invoking remote method 'fs:readFile': Error: File too large: 14.0MB exceeds 10MB limit"
        onRetry={vi.fn()}
      />
    )

    expect(screen.getByTestId('large-file-fallback')).toBeTruthy()
    expect(screen.queryByText('Unable to load file')).toBe(null)
    expect(screen.getByText(/14\.0 MB/)).toBeTruthy()
    expect(screen.getByText(/10 MB/)).toBeTruthy()
  })

  // The local and remote budgets differ on purpose, so the card must not claim otherwise.
  it('does not claim local and remote share one limit', () => {
    render(
      <EditorFileLoadErrorView
        message="File too large: 14.0MB exceeds 10MB limit"
        onRetry={vi.fn()}
      />
    )

    expect(screen.queryByText(/same limit/i)).toBe(null)
  })

  it('keeps the retry affordance so a shrunken file can be reopened', () => {
    const onRetry = vi.fn()
    render(
      <EditorFileLoadErrorView
        message="File too large: 14.0MB exceeds 10MB limit"
        onRetry={onRetry}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('still reports unrelated read failures as errors', () => {
    render(
      <EditorFileLoadErrorView
        message="Access denied: path resolves outside allowed directories"
        onRetry={vi.fn()}
      />
    )

    expect(screen.queryByTestId('large-file-fallback')).toBe(null)
    expect(screen.getByText('Unable to load file')).toBeTruthy()
  })
})
