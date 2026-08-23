import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

type RawRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>

const rawRequest = vi.fn<RawRequest>()
const getClients = vi.fn()
const acquire = vi.fn().mockResolvedValue(undefined)
const release = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: (...args: unknown[]) => acquire(...args),
  release: (...args: unknown[]) => release(...args)
}))

vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: () => false
}))

function makeEntry(options?: {
  workspaceId?: string
  organizationName?: string
  request?: typeof rawRequest
}): LinearClientForWorkspace {
  const workspaceId = options?.workspaceId ?? 'workspace-1'
  return {
    workspace: {
      id: workspaceId,
      organizationId: workspaceId,
      organizationName: options?.organizationName ?? 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { client: { rawRequest: options?.request ?? rawRequest } }
  } as unknown as LinearClientForWorkspace
}

function response(
  ids: string[],
  pageInfo: { hasNextPage: boolean; endCursor?: string } = { hasNextPage: false }
) {
  return {
    data: {
      issues: {
        nodes: ids.map((id) => ({
          id,
          identifier: id,
          title: id,
          url: `https://linear.app/${id}`,
          updatedAt: '2026-01-01T00:00:00.000Z',
          labelIds: [],
          team: { id: 'team-1', name: 'Team', key: 'TM' },
          labels: { nodes: [] }
        })),
        pageInfo
      }
    }
  }
}

describe('Linear agent issue pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([makeEntry()])
  })

  it('walks every page when the caller omits a limit', async () => {
    let page = 0
    rawRequest.mockImplementation(() => {
      const start = page * 50 + 1
      const result = response(
        Array.from({ length: 50 }, (_, index) => `LIN-${start + index}`),
        page < 4 ? { hasNextPage: true, endCursor: `cursor-${start + 49}` } : undefined
      )
      page += 1
      return Promise.resolve(result)
    })
    const { listIssues } = await import('./issues')

    const result = await listIssues('all', null, 'workspace-1')

    expect(result.items).toHaveLength(250)
    expect(result.hasMore).toBe(false)
    expect(rawRequest).toHaveBeenCalledTimes(5)
    expect(acquire).toHaveBeenCalledTimes(5)
    expect(release).toHaveBeenCalledTimes(5)
    expect(rawRequest.mock.calls[4][1]).toMatchObject({ first: 50, after: 'cursor-200' })
  })

  it('preserves explicit limits above the legacy clamp', async () => {
    let page = 0
    rawRequest.mockImplementation((_query, variables) => {
      const count = variables.first as number
      const start = page * 50 + 1
      page += 1
      return Promise.resolve(
        response(
          Array.from({ length: count }, (_, index) => `LIN-${start + index}`),
          page < 5
            ? { hasNextPage: true, endCursor: `cursor-${start + count - 1}` }
            : { hasNextPage: true, endCursor: 'cursor-more' }
        )
      )
    })
    const { listIssues } = await import('./issues')

    const result = await listIssues('all', 220, 'workspace-1')

    expect(result.items).toHaveLength(220)
    expect(result.hasMore).toBe(true)
    expect(rawRequest.mock.calls[4][1]).toMatchObject({ first: 20, after: 'cursor-200' })
  })

  it('stops an exhaustive walk at the page ceiling', async () => {
    let page = 0
    rawRequest.mockImplementation(() => {
      page += 1
      return Promise.resolve(
        response([`LIN-${page}`], { hasNextPage: true, endCursor: `cursor-${page}` })
      )
    })
    const { listIssues } = await import('./issues')

    const result = await listIssues('all', null, 'workspace-1')

    expect(result.items).toHaveLength(200)
    expect(result.hasMore).toBe(true)
    expect(rawRequest).toHaveBeenCalledTimes(200)
  })

  it('fairly exhausts every workspace when the limit is omitted', async () => {
    const firstRequest = workspacePages('W1')
    const secondRequest = workspacePages('W2')
    getClients.mockReturnValue([
      makeEntry({ request: firstRequest }),
      makeEntry({
        workspaceId: 'workspace-2',
        organizationName: 'Second Workspace',
        request: secondRequest
      })
    ])
    const { listIssues } = await import('./issues')

    const result = await listIssues('all', null, 'all')

    expect(result.items).toHaveLength(4)
    expect(result.hasMore).toBe(false)
    expect(firstRequest).toHaveBeenCalledTimes(2)
    expect(secondRequest).toHaveBeenCalledTimes(2)
  })
})

function workspacePages(prefix: string): typeof rawRequest {
  let page = 0
  return vi.fn<RawRequest>().mockImplementation(() => {
    page += 1
    return Promise.resolve(
      response(
        [`${prefix}-${page}`],
        page === 1 ? { hasNextPage: true, endCursor: `${prefix}-cursor-1` } : undefined
      )
    )
  })
}
