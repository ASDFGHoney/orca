import {
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { readHostedWebViewControlPoint } from './hosted-webview-control-point.mjs'
import {
  tapHostedIosAccessibilityControl,
  tapHostedIosPoint
} from './hosted-ios-emulator-accessibility.mjs'
import {
  captureHostedSourceControlReviewScreen,
  sourceControlReviewParityEvidence
} from './hosted-ios-source-control-review-parity.mjs'
import { navigateHostedWebViewRoute } from './hosted-webview-route-navigation.mjs'
import {
  readHostedWebViewBridgeErrors,
  startHostedWebViewBridgeErrorObservation
} from './hosted-webview-bridge-error-observation.mjs'

const SOURCE_CONTROL_SETTLE_TIMEOUT_MS = 15_000

export async function verifyHostedSourceControlReviewJourney({
  deviceUdid,
  discoveryUrl,
  emulator,
  nativeBaselines,
  runtimeDirectory,
  sessionDocument,
  timeoutMs,
  expectedSessionDiffText = '2 tabs',
  inspectChangedContent,
  inspectProviderContent,
  tapPoint = tapHostedJourneyPoint,
  transformPoint = retainHostedJourneyPoint
}) {
  await startHostedWebViewBridgeErrorObservation(sessionDocument)
  const sourceControl = await journeyStep('wait for Source Control route', () =>
    openSourceControlRoute({
      discoveryUrl,
      emulator,
      sessionDocument,
      timeoutMs,
      tapPoint,
      transformPoint
    })
  )
  let sourceState = await journeyStep('read populated Source Control state', () =>
    waitForChangedFileState(sourceControl, timeoutMs)
  )
  for (const label of ['Changes', 'Pull Request', 'Commits', 'Refresh source control']) {
    if (!sourceState.bodyText.includes(label) && !sourceState.labels.includes(label)) {
      throw new Error(`Source Control is missing ${label}.`)
    }
  }
  if (inspectProviderContent) {
    await journeyStep('open provider review content', () =>
      openSourceControlSegment({
        document: sourceControl,
        label: 'Pull Request',
        tapPoint,
        emulator,
        transformPoint
      })
    )
    await journeyStep('inspect provider review content', () =>
      inspectProviderContent({ document: sourceControl })
    )
    await journeyStep('restore changed files segment', () =>
      openSourceControlSegment({
        document: sourceControl,
        label: 'Changes',
        tapPoint,
        emulator,
        transformPoint
      })
    )
    sourceState = await journeyStep('restore changed Source Control state', () =>
      waitForChangedFileState(sourceControl, timeoutMs)
    )
  }

  if (inspectChangedContent) {
    await journeyStep('inspect Source Control content', () =>
      inspectChangedContent({ phase: 'sourceControl', document: sourceControl })
    )
  }
  if (nativeBaselines) {
    sourceState = await journeyStep('wait for stable Source Control parity state', () =>
      waitForSourceControlParityState(
        sourceControl,
        timeoutMs,
        sourceState,
        nativeBaselines.sourceControl.pullRequestState
      )
    )
  }
  const changedFileLabel = selectChangedFileLabel(sourceState, nativeBaselines)
  const hostedSourceControl = nativeBaselines
    ? await journeyStep('capture Source Control parity', () =>
        captureHostedSourceControlReviewScreen({
          deviceUdid,
          document: sourceControl,
          nativeBaseline: nativeBaselines.sourceControl,
          runtimeDirectory,
          screenshotName: 'hosted-source-control-portrait.png',
          title: 'Source Control',
          timeoutMs
        })
      )
    : null
  const sessionDiff = await journeyStep('wait for Session diff route', () =>
    openSessionDiffRoute({
      discoveryUrl,
      emulator,
      expectedText: expectedSessionDiffText,
      label: changedFileLabel,
      sourceControl,
      tapPoint,
      timeoutMs,
      transformPoint
    })
  )
  if (inspectChangedContent) {
    await journeyStep('inspect Session diff content', () =>
      inspectChangedContent({ phase: 'sessionDiff', document: sessionDiff })
    )
  }
  await journeyStep('open standalone Review route', () =>
    navigateHostedWebViewRoute(sessionDiff, standaloneReviewRoute(sourceState.href))
  )
  const review = await journeyStep('wait for Review route', () =>
    waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: 'reviewed',
      expectedHrefIncludes: '/review/',
      timeoutMs
    })
  )
  const reviewState = await journeyStep('read Review state', () => readHostedWebViewState(review))
  for (const label of ['Back', 'Open review actions']) {
    if (!reviewState.labels.includes(label)) {
      throw new Error(`Review is missing ${label}.`)
    }
  }
  if (inspectChangedContent) {
    await journeyStep('inspect Review content', () =>
      inspectChangedContent({ phase: 'review', document: review })
    )
  }
  const hostedReview = nativeBaselines
    ? await journeyStep('capture Review parity', () =>
        captureHostedSourceControlReviewScreen({
          deviceUdid,
          document: review,
          nativeBaseline: nativeBaselines.review,
          runtimeDirectory,
          screenshotName: 'hosted-review-portrait.png',
          title: 'Changes',
          timeoutMs
        })
      )
    : null

  return {
    sourceControlRoute: sourceState.href,
    sourceControlSegments: ['Changes', 'Pull Request', 'Commits'],
    sessionDiffRoute: sessionDiff.href,
    reviewRoute: reviewState.href,
    reviewControls: ['Back', 'Open review actions'],
    ...(hostedSourceControl && hostedReview
      ? {
          parityFixture: {
            sourceControl: sourceControlReviewParityEvidence(
              nativeBaselines.sourceControl,
              hostedSourceControl
            ),
            review: sourceControlReviewParityEvidence(nativeBaselines.review, hostedReview)
          }
        }
      : {})
  }
}

async function openSourceControlSegment({ document, emulator, label, tapPoint, transformPoint }) {
  const point = await readHostedWebViewControlPoint(document, label)
  // Segment labels can have duplicate AX descendants, so target the measured control.
  await tapPoint(emulator, transformPoint(point, document), label, 1, document)
}

async function tapHostedJourneyPoint(emulator, point, label, attempt = 0) {
  if (label && attempt === 0) {
    try {
      return await tapHostedIosAccessibilityControl(emulator, label, 5_000)
    } catch {
      // WebKit can omit a descendant while refreshing its accessibility tree.
    }
  }
  return tapHostedIosPoint(emulator, point)
}

async function openSourceControlRoute({
  discoveryUrl,
  emulator,
  sessionDocument,
  timeoutMs,
  tapPoint,
  transformPoint
}) {
  let lastError = new Error('Source Control route did not open')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const point = await readHostedWebViewControlPoint(sessionDocument, 'Open source control')
      await tapPoint(
        emulator,
        transformPoint(point, sessionDocument),
        'Open source control',
        attempt,
        sessionDocument
      )
      return await waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: 'Source Control',
        expectedHrefIncludes: '/source-control/',
        timeoutMs: Math.min(timeoutMs, 3_000)
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function openSessionDiffRoute({
  discoveryUrl,
  emulator,
  expectedText,
  label,
  sourceControl,
  tapPoint,
  timeoutMs,
  transformPoint
}) {
  let lastError = new Error('Session diff route did not open')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const point = await readHostedWebViewControlPoint(sourceControl, label)
      await tapPoint(emulator, transformPoint(point, sourceControl), label, attempt, sourceControl)
    } catch (error) {
      lastError = error
      continue
    }
    try {
      return await waitForSessionDiff(discoveryUrl, expectedText, Math.min(timeoutMs, 3_000))
    } catch (error) {
      lastError = error
    }
    const transitioned = await waitForSessionDiff(discoveryUrl, '', 1_000).catch(() => null)
    if (transitioned) {
      return waitForSessionDiff(discoveryUrl, expectedText, timeoutMs)
    }
  }
  throw lastError
}

function waitForSessionDiff(discoveryUrl, expectedText, timeoutMs) {
  return waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText,
    expectedHrefIncludes: '/session/',
    requireInteractiveControls: false,
    timeoutMs
  })
}

async function waitForChangedFileState(document, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = await readHostedWebViewState(document)
    if (state.labels.some((label) => label.startsWith('Open changed file '))) {
      return state
    }
    await delay(250)
  }
  return state ?? readHostedWebViewState(document)
}

async function waitForSourceControlParityState(
  document,
  timeoutMs,
  initialState,
  pullRequestState
) {
  const deadline = Date.now() + Math.min(timeoutMs, SOURCE_CONTROL_SETTLE_TIMEOUT_MS)
  let state = initialState
  while (Date.now() < deadline) {
    if (sourceControlMatchesPullRequestState(state, pullRequestState)) {
      return state
    }
    await delay(250)
    state = await readHostedWebViewState(document)
  }
  const bridgeErrors = await readHostedWebViewBridgeErrors(document)
  throw new Error(
    `Source Control did not settle its branch and pull-request state. Bridge errors: ${JSON.stringify(bridgeErrors)}`
  )
}

function sourceControlMatchesPullRequestState(state, pullRequestState) {
  if (!/\b\d+ on branch\b/.test(state.bodyText) || !pullRequestState) {
    return false
  }
  if (state.labels.includes(pullRequestState.label)) {
    return true
  }
  if (pullRequestState.kind === 'create') {
    return state.bodyText.includes('Create pull request')
  }
  if (pullRequestState.kind === 'ready') {
    return state.bodyText.includes(`#${pullRequestState.number}`)
  }
  return state.bodyText.includes(pullRequestState.label.replace('Pull request unavailable: ', ''))
}

function selectChangedFileLabel(sourceState, nativeBaselines) {
  const nativeLabel = nativeBaselines?.sourceControl.changedFileLabel
  if (nativeLabel && sourceState.labels.includes(nativeLabel)) {
    return nativeLabel
  }
  if (nativeLabel) {
    throw new Error(`Source Control is missing the native baseline file: ${nativeLabel}`)
  }
  const label = sourceState.labels.find((candidate) => candidate.startsWith('Open changed file '))
  if (!label) {
    throw new Error('Source Control has no changed file available for Review.')
  }
  return label
}

function standaloneReviewRoute(sourceControlHref) {
  const url = new URL(sourceControlHref)
  const pathname = url.pathname.replace('/source-control/', '/review/')
  if (pathname === url.pathname) {
    throw new Error('Source Control route cannot open standalone Review')
  }
  const params = new URLSearchParams({ scope: 'all' })
  const name = url.searchParams.get('name')
  if (name) {
    params.set('name', name)
  }
  return `${pathname}?${params.toString()}`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retainHostedJourneyPoint(point) {
  return point
}

async function journeyStep(label, run) {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
}
