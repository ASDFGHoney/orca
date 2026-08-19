import { describe, expect, it, vi } from 'vitest'

import { retireBrowserRoutePartitionStorageForEnvironment } from './browser-route-partition-storage-retirement'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`

describe('browser route partition storage retirement', () => {
  it('clears a removed environment only after its client host finishes tearing down', async () => {
    const order: string[] = []
    let finishTeardown = (): void => {}
    const whenClientHostClosed = new Promise<void>((resolve) => {
      finishTeardown = () => {
        order.push('teardown')
        resolve()
      }
    })
    const clearStorage = vi.fn(async () => {
      order.push('clear')
      return { clearedPartitions: [partition], livePartitions: [] }
    })

    const retiring = retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed,
      clearStorage,
      retryDelayMs: 0
    })
    await Promise.resolve()
    expect(clearStorage).not.toHaveBeenCalled()

    finishTeardown()

    expect(await retiring).toEqual([partition])
    expect(order).toEqual(['teardown', 'clear'])
    expect(clearStorage).toHaveBeenCalledOnce()
  })

  it('retries a partition that was still live during the first pass', async () => {
    const clearStorage = vi
      .fn()
      .mockResolvedValueOnce({ clearedPartitions: [], livePartitions: [partition] })
      .mockResolvedValueOnce({ clearedPartitions: [partition], livePartitions: [] })
    const onError = vi.fn()

    const cleared = await retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed: Promise.resolve(),
      clearStorage,
      retryDelayMs: 0,
      onError
    })

    expect(cleared).toEqual([partition])
    expect(clearStorage).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a partition that stays live and never retries a third time', async () => {
    const clearStorage = vi
      .fn()
      .mockResolvedValue({ clearedPartitions: [], livePartitions: [partition] })
    const onError = vi.fn()

    const cleared = await retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed: Promise.resolve(),
      clearStorage,
      retryDelayMs: 0,
      onError
    })

    expect(cleared).toEqual([])
    expect(clearStorage).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(partition) })
    )
  })

  it('still clears storage when the client host teardown fails', async () => {
    const clearStorage = vi
      .fn()
      .mockResolvedValue({ clearedPartitions: [partition], livePartitions: [] })
    const onError = vi.fn()

    const cleared = await retireBrowserRoutePartitionStorageForEnvironment({
      environmentId: 'environment-a',
      whenClientHostClosed: Promise.reject(new Error('teardown failed')),
      clearStorage,
      retryDelayMs: 0,
      onError
    })

    expect(cleared).toEqual([partition])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'teardown failed' }))
  })
})
