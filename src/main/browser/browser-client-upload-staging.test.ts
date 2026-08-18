import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BrowserClientUploadStaging } from './browser-client-upload-staging'

let stagingRoot = ''

beforeEach(async () => {
  // Why: macOS reports /private/var for a /var mkdtemp path, so compare against the resolved root.
  stagingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-upload-staging-')))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

describe('BrowserClientUploadStaging', () => {
  it('writes remote bytes under main-owned directories and keeps the remote basename', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)

    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 3,
      files: [
        { remotePath: 'docs/report.pdf', contents: Buffer.from('one') },
        { remotePath: 'notes.txt', contents: Buffer.from('two') }
      ]
    })

    expect(staged.localFilePaths.map((file) => path.basename(file))).toEqual([
      'report.pdf',
      'notes.txt'
    ])
    for (const file of staged.localFilePaths) {
      expect(await realpath(file)).toContain(stagingRoot)
    }
    expect(await readFile(staged.localFilePaths[0], 'utf8')).toBe('one')
    expect(await readFile(staged.localFilePaths[1], 'utf8')).toBe('two')
  })

  it('never lets a remote path escape the staging root', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)

    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: '../../../etc/passwd', contents: Buffer.from('x') }]
    })

    expect(path.basename(staged.localFilePaths[0])).toBe('passwd')
    expect(path.resolve(staged.localFilePaths[0]).startsWith(stagingRoot)).toBe(true)
  })

  it('removes the staged directory when the page is released', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 4,
      files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
    })

    expect(await staging.releasePage('page-2')).toBe(0)
    expect(await readdir(stagingRoot)).toHaveLength(1)

    expect(await staging.releasePage('page-1')).toBe(1)
    expect(await readdir(stagingRoot)).toHaveLength(0)
    expect(staging.stagedDirectory(staged.stagingId)).toBeUndefined()
  })

  it('releases only the matching page generation when one is named', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
    })
    await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 2,
      files: [{ remotePath: 'b.txt', contents: Buffer.from('b') }]
    })

    expect(await staging.releasePage('page-1', 1)).toBe(1)
    expect(staging.activeStagingCount()).toBe(1)
  })

  it('cleans up the partial directory when a write fails', async () => {
    let writes = 0
    const staging = new BrowserClientUploadStaging(stagingRoot, {
      mkdir: async () => {},
      writeFile: async () => {
        writes += 1
        throw new Error('disk full')
      },
      removeDirectory: async () => {}
    })

    await expect(
      staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
      })
    ).rejects.toThrow('disk full')
    expect(writes).toBe(1)
    expect(staging.activeStagingCount()).toBe(0)
  })

  it('rejects an oversized or over-counted staging request before touching disk', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)

    await expect(
      staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: Array.from({ length: 17 }, (_unused, index) => ({
          remotePath: `${index}.txt`,
          contents: Buffer.alloc(1)
        }))
      })
    ).rejects.toThrow('browser_client_upload_file_count_exceeded')

    await expect(
      staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: [{ remotePath: 'big.bin', contents: Buffer.alloc(64 * 1024 * 1024 + 1) }]
      })
    ).rejects.toThrow('browser_client_upload_too_large')

    expect(await readdir(stagingRoot)).toHaveLength(0)
  })
})
