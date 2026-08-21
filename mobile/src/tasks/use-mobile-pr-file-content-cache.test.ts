import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRFileContents } from '../../../src/shared/github/pull-request-types'
import { useMobilePrFileContentCache } from './use-mobile-pr-file-content-cache'

type CacheResult = ReturnType<typeof useMobilePrFileContentCache>

let renderer: ReactTestRenderer | null = null
let result: CacheResult | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  result = null
})

describe('useMobilePrFileContentCache', () => {
  it('resets cached content synchronously when the review scope changes', async () => {
    renderHarness('scope-a')
    await loadFile('scope-a', 'a.ts', fileContents('old'))

    expect(result?.contents['a.ts']?.modified).toBe('old')

    act(() => renderer?.update(createElement(Harness, { scope: 'scope-b' })))

    expect(result?.contents).toEqual({})
    expect(result?.loadingPath).toBeNull()
  })

  it('ignores a completed request from the previous scope', async () => {
    const request = deferred<GitHubPRFileContents>()
    renderHarness('scope-a')
    let pending: Promise<void> | undefined
    act(() => {
      pending = result?.load('scope-a', { path: 'a.ts' }, () => request.promise, vi.fn())
    })

    expect(result?.loadingPath).toBe('a.ts')
    act(() => renderer?.update(createElement(Harness, { scope: 'scope-b' })))
    await act(async () => {
      request.resolve(fileContents('stale'))
      await pending
    })

    expect(result?.contents).toEqual({})
    expect(result?.loadingPath).toBeNull()
  })
})

function Harness({ scope }: { scope: string | null }): null {
  result = useMobilePrFileContentCache(scope)
  return null
}

function renderHarness(scope: string | null): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  act(() => {
    renderer = create(createElement(Harness, { scope }))
  })
}

async function loadFile(
  scope: string,
  path: string,
  contents: GitHubPRFileContents
): Promise<void> {
  await act(async () => {
    await result?.load(scope, { path }, async () => contents, vi.fn())
  })
}

function fileContents(modified: string): GitHubPRFileContents {
  return {
    original: '',
    modified,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
