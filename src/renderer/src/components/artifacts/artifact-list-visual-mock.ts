import type { ArtifactListItem } from '../../../../shared/artifacts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function mockArtifact({
  slug,
  title,
  fileName,
  sourceContentType,
  shareUrl,
  byteSize,
  updatedAgoMs,
  expiresInMs,
  now
}: {
  slug: string
  title: string
  fileName: string
  sourceContentType: 'text/html' | 'text/markdown'
  shareUrl: string
  byteSize: number
  updatedAgoMs: number
  expiresInMs: number
  now: number
}): ArtifactListItem {
  const updatedAt = new Date(now - updatedAgoMs).toISOString()
  return {
    artifact: {
      version: 1,
      slug,
      title,
      originalFileName: fileName,
      sourceContentType,
      renderedContentType: 'text/html',
      createdAt: new Date(now - updatedAgoMs - DAY_MS).toISOString(),
      updatedAt,
      expiresAt: new Date(now + expiresInMs).toISOString(),
      byteSize,
      deletedAt: null
    },
    shareUrl
  }
}

/** Sample rows for reviewing the artifacts table and detail drawer locally. */
export function createArtifactListVisualMock(now = Date.now()): readonly ArtifactListItem[] {
  return [
    mockArtifact({
      slug: 'quarterly-report',
      title: 'Quarterly report',
      fileName: 'quarterly-report.html',
      sourceContentType: 'text/html',
      shareUrl: 'https://example.com',
      byteSize: 128_000,
      updatedAgoMs: HOUR_MS,
      expiresInMs: 30 * DAY_MS,
      now
    }),
    mockArtifact({
      slug: 'architecture-notes',
      title: 'Architecture notes',
      fileName: 'architecture-notes.md',
      sourceContentType: 'text/markdown',
      shareUrl: 'https://example.org',
      byteSize: 4_200,
      updatedAgoMs: 2 * DAY_MS,
      expiresInMs: 12 * DAY_MS,
      now
    }),
    mockArtifact({
      slug: 'demo-deck',
      title: 'Demo deck',
      fileName: 'demo-deck.html',
      sourceContentType: 'text/html',
      shareUrl: 'https://info.cern.ch',
      byteSize: 980_000,
      updatedAgoMs: 8 * DAY_MS,
      expiresInMs: 3 * DAY_MS,
      now
    }),
    mockArtifact({
      slug: 'onboarding-walkthrough',
      title: 'Onboarding walkthrough',
      fileName: 'onboarding.html',
      sourceContentType: 'text/html',
      shareUrl: 'https://example.net',
      byteSize: 56_400,
      updatedAgoMs: 20 * 60 * 1000,
      expiresInMs: 45 * DAY_MS,
      now
    }),
    mockArtifact({
      slug: 'incident-postmortem',
      title: 'Incident postmortem',
      fileName: 'incident-postmortem.md',
      sourceContentType: 'text/markdown',
      shareUrl: 'https://example.com/postmortem',
      byteSize: 18_200,
      updatedAgoMs: 5 * DAY_MS,
      expiresInMs: -DAY_MS,
      now
    }),
    mockArtifact({
      slug: 'api-changelog',
      title: 'API changelog',
      fileName: 'api-changelog.md',
      sourceContentType: 'text/markdown',
      shareUrl: 'https://example.org/changelog',
      byteSize: 8_900,
      updatedAgoMs: 14 * DAY_MS,
      expiresInMs: 2 * DAY_MS,
      now
    }),
    mockArtifact({
      slug: 'launch-checklist',
      title: 'Launch checklist',
      fileName: 'launch-checklist.html',
      sourceContentType: 'text/html',
      shareUrl: 'https://example.net/launch',
      byteSize: 240_000,
      updatedAgoMs: 3 * HOUR_MS,
      expiresInMs: 7 * DAY_MS,
      now
    }),
    mockArtifact({
      slug: 'research-brief',
      title: 'Research brief',
      fileName: 'research-brief.md',
      sourceContentType: 'text/markdown',
      shareUrl: 'https://example.com/research',
      byteSize: 2_100,
      updatedAgoMs: 5 * 60 * 1000,
      expiresInMs: 60 * DAY_MS,
      now
    })
  ]
}

export function shouldShowArtifactListVisualMock(): boolean {
  return import.meta.env.DEV
}
