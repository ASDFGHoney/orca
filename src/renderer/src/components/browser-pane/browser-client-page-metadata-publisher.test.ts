import { describe, expect, it, vi } from 'vitest'
import { createBrowserClientPageMetadataPublisher } from './browser-client-page-metadata-publisher'

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

describe('browser client page metadata publisher', () => {
  it('keeps one call in flight and coalesces to the latest full snapshot', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const call = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    let revision = 0
    const publisher = createBrowserClientPageMetadataPublisher({
      environmentId: 'environment-a',
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision: () => ++revision,
      call
    })

    publisher.publish(snapshot('First'))
    publisher.publish(snapshot('Second'))
    publisher.publish(snapshot('Latest'))

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenNthCalledWith(1, {
      selector: 'environment-a',
      method: 'browser.clientHost.pageMetadata',
      params: expect.objectContaining({ revision: 1, title: 'First' })
    })
    first.resolve({ ok: true, result: { accepted: true } })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call).toHaveBeenNthCalledWith(2, {
      selector: 'environment-a',
      method: 'browser.clientHost.pageMetadata',
      params: expect.objectContaining({ revision: 2, title: 'Latest' })
    })
    second.resolve({ ok: true, result: { accepted: true } })
  })

  it('drops pending work after disposal without starting another call', async () => {
    const first = deferred<unknown>()
    const call = vi.fn().mockReturnValue(first.promise)
    let revision = 0
    const publisher = createBrowserClientPageMetadataPublisher({
      environmentId: 'environment-a',
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision: () => ++revision,
      call
    })

    publisher.publish(snapshot('First'))
    publisher.publish(snapshot('Pending'))
    publisher.dispose()
    first.resolve({ ok: true, result: { accepted: true } })
    await Promise.resolve()

    expect(call).toHaveBeenCalledTimes(1)
  })
})

function snapshot(title: string) {
  return {
    url: 'https://example.com/',
    title,
    loading: false,
    canGoBack: true,
    canGoForward: false
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
