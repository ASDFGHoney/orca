import { useCallback, useRef } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isEditableKeyboardTarget } from '../host-guest/browser-keyboard'
import {
  getRemoteBrowserKeyboardShortcut,
  getRemoteBrowserKeypressKey
} from './remote-browser-keyboard'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import { sendRemoteBrowserClick } from './remote-browser-click-dispatch'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import {
  getPositiveFiniteNumber,
  getRemoteBrowserMouseButton,
  hasRemoteBrowserClickModifier,
  isSimpleRemoteBrowserClick,
  type PendingRemoteBrowserWheel,
  type RemoteBrowserPaneNotice,
  type RemoteBrowserPressState,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageInputQueue(): {
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  clearPendingRemoteWheel: () => void
  resetRemoteInputQueue: () => void
  pendingRemoteWheelRef: React.MutableRefObject<PendingRemoteBrowserWheel | null>
  remoteWheelFrameRef: React.MutableRefObject<number | null>
  remoteWheelInFlightRef: React.MutableRefObject<boolean>
} {
  const remoteInputQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const pendingRemoteWheelRef = useRef<PendingRemoteBrowserWheel | null>(null)
  const remoteWheelFrameRef = useRef<number | null>(null)
  const remoteWheelInFlightRef = useRef(false)

  const enqueueRemoteInput = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = remoteInputQueueRef.current.catch(() => {}).then(operation)
    remoteInputQueueRef.current = next.catch(() => {})
    return next
  }, [])

  const resetRemoteInputQueue = useCallback((): void => {
    remoteInputQueueRef.current = Promise.resolve()
  }, [])

  const clearPendingRemoteWheel = useCallback((): void => {
    pendingRemoteWheelRef.current = null
    remoteWheelInFlightRef.current = false
    if (remoteWheelFrameRef.current !== null) {
      window.cancelAnimationFrame(remoteWheelFrameRef.current)
      remoteWheelFrameRef.current = null
    }
  }, [])

  return {
    enqueueRemoteInput,
    clearPendingRemoteWheel,
    resetRemoteInputQueue,
    pendingRemoteWheelRef,
    remoteWheelFrameRef,
    remoteWheelInFlightRef
  }
}

export function useRemoteBrowserPageInput({
  busy,
  imageRef,
  remoteViewportRef,
  remoteCssViewportSizeRef,
  remoteViewportSizeRef,
  frameMetadata,
  runtimeTarget,
  lifecycle,
  runtimeWorktree,
  enqueueRemoteInput,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  scheduleRemoteTabInfoRefresh,
  setPaneNotice
}: {
  busy: boolean
  imageRef: React.RefObject<HTMLImageElement | null>
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  remoteCssViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  remoteViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  frameMetadata: BrowserScreencastFrameMetadata | null
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}): {
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
  handleRemotePointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerCancel: () => void
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
} {
  const pendingPressRef = useRef<RemoteBrowserPressState | null>(null)
  // Hosts predating browser.mouseClick answer method_not_found; remember per environment so the
  // legacy chain is not re-probed on every click.
  const mouseClickUnsupportedEnvironmentRef = useRef<string | null>(null)

  const getRemoteImagePoint = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const image = imageRef.current
      const viewport = remoteViewportRef.current
      if (!image || !viewport) {
        return null
      }
      const rect = viewport.getBoundingClientRect()
      const viewportWidth =
        getPositiveFiniteNumber(remoteCssViewportSizeRef.current?.width) ??
        getPositiveFiniteNumber(remoteViewportSizeRef.current?.width) ??
        getPositiveFiniteNumber(frameMetadata?.deviceWidth) ??
        image.naturalWidth
      const viewportHeight =
        getPositiveFiniteNumber(remoteCssViewportSizeRef.current?.height) ??
        getPositiveFiniteNumber(remoteViewportSizeRef.current?.height) ??
        getPositiveFiniteNumber(frameMetadata?.deviceHeight) ??
        image.naturalHeight
      if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
        return null
      }
      return {
        x: Math.round(((event.clientX - rect.left) / rect.width) * viewportWidth),
        y: Math.round(((event.clientY - rect.top) / rect.height) * viewportHeight)
      }
    },
    [frameMetadata, imageRef, remoteCssViewportSizeRef, remoteViewportRef, remoteViewportSizeRef]
  )

  // Why the press is held until release: a plain click then costs one atomic browser.mouseClick
  // instead of four serialized round trips, and only the release proves it was not a drag.
  const handleRemotePointerDown = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const image = imageRef.current
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    if (button === 'right') {
      return
    }
    if (!target || !pageId || !image || !point || !button) {
      return
    }
    event.preventDefault()
    image.focus()
    setPaneNotice(null)
    pendingPressRef.current = {
      environmentId: target.environmentId,
      pageId,
      button,
      point,
      modified: hasRemoteBrowserClickModifier(event)
    }
  }

  const handleRemotePointerCancel = (): void => {
    pendingPressRef.current = null
  }

  const handleRemotePointerUp = (event: React.PointerEvent<HTMLImageElement>): void => {
    const press = pendingPressRef.current
    pendingPressRef.current = null
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    if (button === 'right') {
      return
    }
    if (!press || !target || !pageId || !operationToken || !point || !button) {
      return
    }
    const release: RemoteBrowserPressState = {
      environmentId: target.environmentId,
      pageId,
      button,
      point,
      modified: hasRemoteBrowserClickModifier(event)
    }
    if (press.environmentId !== release.environmentId || press.pageId !== release.pageId) {
      return
    }
    event.preventDefault()
    setPaneNotice(null)
    const atomic = isSimpleRemoteBrowserClick(press, release)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        await sendRemoteBrowserClick({
          target,
          params: { worktree: runtimeWorktree, page: pageId },
          press,
          release,
          preferAtomicClick:
            atomic && mouseClickUnsupportedEnvironmentRef.current !== target.environmentId,
          onAtomicClickUnsupported: () => {
            mouseClickUnsupportedEnvironmentRef.current = target.environmentId
          }
        })
        scheduleRemoteTabInfoRefresh(operationToken, 250)
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Remote mouse input failed.'
          })
        }
      }
    })
  }

  const handleRemoteScreenshotKeyDown = (event: React.KeyboardEvent<HTMLImageElement>): void => {
    if (isEditableKeyboardTarget(event.target)) {
      return
    }
    const target = runtimeTarget()
    const pageId = lifecycle.tokens.remotePage
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    if (!target || !pageId || !operationToken) {
      return
    }
    const params = { worktree: runtimeWorktree, page: pageId }
    const key = getRemoteBrowserKeyboardShortcut(event) ?? getRemoteBrowserKeypressKey(event)
    if (!key) {
      return
    }
    event.preventDefault()
    setPaneNotice(null)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        await callRuntimeRpc(
          target,
          'browser.keypress',
          { ...params, key },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        if (
          key === 'Enter' ||
          key === 'Meta+r' ||
          key === 'Meta+Shift+r' ||
          key === 'Control+r' ||
          key === 'Control+Shift+r'
        ) {
          scheduleRemoteTabInfoRefresh(operationToken, 400)
        }
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Remote keyboard input failed.'
          })
        }
      }
    })
  }

  return {
    getRemoteImagePoint,
    handleRemotePointerDown,
    handleRemotePointerUp,
    handleRemotePointerCancel,
    handleRemoteScreenshotKeyDown
  }
}
