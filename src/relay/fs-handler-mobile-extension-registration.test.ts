import { describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { FsHandler } from './fs-handler'

describe('mobile relay filesystem extensions', () => {
  it('registers every bounded operation used by the SSH provider', () => {
    const requests = new Set<string>()
    const dispatcher = {
      onRequest: (method: string) => requests.add(method),
      onNotification: vi.fn(),
      notify: vi.fn(),
      notifyClient: vi.fn(),
      onClientDetached: vi.fn(() => () => {})
    }
    const handler = new FsHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())

    try {
      for (const method of [
        'fs.readDirBounded',
        'fs.readFileChunk',
        'fs.readTerminalArtifactChunk',
        'fs.listMarkdownDocuments'
      ]) {
        expect(requests).toContain(method)
      }
    } finally {
      handler.dispose()
    }
  })
})
