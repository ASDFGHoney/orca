import {
  REMOTE_BROWSER_STREAM_LIVE,
  remoteBrowserStreamLostNotice,
  remoteBrowserStreamStopped
} from './remote-browser-stream-status'
import type { RemoteBrowserStreamLifecycleDeps } from './remote-browser-stream-lifecycle-deps'
import type { RemoteBrowserStreamLiveness } from './remote-browser-stream-liveness'
import type { RemoteBrowserScreencastEvents } from './remote-browser-screencast-subscription'
import type {
  RemoteBrowserOperationTokens,
  RemoteBrowserStreamToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'

type RemoteBrowserStreamEventDeps = Pick<
  RemoteBrowserStreamLifecycleDeps,
  'applyTabInfo' | 'closeMissingRemotePage' | 'handleFrameBytes' | 'setStatus' | 'syncViewport'
> & {
  tokens: RemoteBrowserOperationTokens
  liveness: RemoteBrowserStreamLiveness
  handleClosed: (restart: boolean) => void
}

export function createRemoteBrowserStreamEvents(
  pageId: string,
  token: RemoteBrowserStreamToken,
  viewportSize: RemoteBrowserViewportSize | null,
  deps: RemoteBrowserStreamEventDeps
): RemoteBrowserScreencastEvents {
  return {
    isCurrent: () => deps.tokens.isCurrentStreamToken(token),
    onReady: (event) => {
      deps.liveness.markReady()
      deps.setStatus(REMOTE_BROWSER_STREAM_LIVE)
      deps.applyTabInfo(event.tab)
      void deps.syncViewport(event.browserPageId, viewportSize).catch(() => {})
    },
    onEnded: () => deps.handleClosed(true),
    onFailed: (message) => {
      deps.setStatus(remoteBrowserStreamStopped(message))
      deps.handleClosed(false)
    },
    // Transport errors can arrive without close; stop the ready deadline and leave Reconnect usable.
    onTransportError: () => {
      deps.liveness.stopWaitingForReady()
      deps.setStatus(remoteBrowserStreamStopped(remoteBrowserStreamLostNotice()))
    },
    onPageMissing: () => deps.closeMissingRemotePage(pageId),
    onFrame: (bytes) => deps.handleFrameBytes(token, bytes),
    onClosed: () => deps.handleClosed(true)
  }
}
