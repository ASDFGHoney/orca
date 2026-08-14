/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: BrowserPane synchronizes Electron webviews, remote browser drivers, streams, downloads, and annotation overlays; those external lifecycles cannot be derived during render. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { BrowserPageAnnotation } from '../../../../../shared/browser-grab-types'
import { formatBrowserAnnotationsAsMarkdown } from '../browser-annotation-output'
import { EMPTY_BROWSER_ANNOTATIONS } from './browser-annotation-geometry'

export function useBrowserPageAnnotationSend({
  browserTabId,
  worktreeId
}: {
  browserTabId: string
  worktreeId: string
}): {
  browserAnnotations: BrowserPageAnnotation[]
  browserAnnotationsPrompt: string
  browserAnnotationTrayOpen: boolean
  setBrowserAnnotationTrayOpen: Dispatch<SetStateAction<boolean>>
  browserAnnotationsCopied: boolean
  annotationBannerSendOpen: boolean
  annotationTraySendOpen: boolean
  handleAnnotationBannerSendOpenChange: (open: boolean) => void
  handleAnnotationTraySendOpenChange: (open: boolean) => void
  handleCopyBrowserAnnotations: () => void
  handleClearBrowserAnnotations: () => void
  handleDeleteBrowserAnnotation: (annotationId: string) => void
  handleBrowserAnnotationsSentToAgent: () => void
  activeGroupId: string | undefined
} {
  const browserAnnotations = useAppStore(
    (s) => s.browserAnnotationsByPageId[browserTabId] ?? EMPTY_BROWSER_ANNOTATIONS
  )
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  const browserAnnotationsRef = useRef(browserAnnotations)
  browserAnnotationsRef.current = browserAnnotations
  const [browserAnnotationTrayOpen, setBrowserAnnotationTrayOpen] = useState(true)
  const [browserAnnotationsCopied, setBrowserAnnotationsCopied] = useState(false)
  const annotationCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const browserAnnotationsPrompt = useMemo(
    () => formatBrowserAnnotationsAsMarkdown(browserAnnotations),
    [browserAnnotations]
  )
  const openAgentSendPopoverTargetMode = useAppStore((s) => s.openAgentSendPopoverTargetMode)
  const closeAgentSendPopoverTargetMode = useAppStore((s) => s.closeAgentSendPopoverTargetMode)
  const activeAgentSendTargetModeId = useAppStore((s) => s.agentSendPopoverTargetMode?.id ?? null)
  const annotationBannerSendModeId = `browser-annotations:${browserTabId}:banner`
  const annotationTraySendModeId = `browser-annotations:${browserTabId}:tray`
  const [annotationBannerSendOpen, setAnnotationBannerSendOpen] = useState(false)
  const [annotationTraySendOpen, setAnnotationTraySendOpen] = useState(false)
  const deleteBrowserPageAnnotation = useAppStore((s) => s.deleteBrowserPageAnnotation)
  const clearBrowserPageAnnotations = useAppStore((s) => s.clearBrowserPageAnnotations)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  useEffect(() => {
    return () => {
      clearTimeout(annotationCopyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    setBrowserAnnotationTrayOpen(true)
    setBrowserAnnotationsCopied(false)
    clearTimeout(annotationCopyTimerRef.current)
  }, [browserTabId])

  useEffect(() => {
    if (browserAnnotations.length === 0) {
      setBrowserAnnotationTrayOpen(true)
      setBrowserAnnotationsCopied(false)
      clearTimeout(annotationCopyTimerRef.current)
    }
  }, [browserAnnotations.length])

  const handleAnnotationBannerSendOpenChange = useCallback(
    (open: boolean): void => {
      setAnnotationBannerSendOpen(open)
      if (open) {
        openAgentSendPopoverTargetMode({
          id: annotationBannerSendModeId,
          worktreeId,
          source: 'browser-annotations',
          prompt: browserAnnotationsPrompt,
          label: translate(
            'auto.components.browser.pane.BrowserPane.27d863542c',
            'Browser annotations'
          ),
          launchSource: 'notes_send'
        })
      } else {
        closeAgentSendPopoverTargetMode(annotationBannerSendModeId)
      }
    },
    [
      annotationBannerSendModeId,
      browserAnnotationsPrompt,
      closeAgentSendPopoverTargetMode,
      openAgentSendPopoverTargetMode,
      worktreeId
    ]
  )

  const handleAnnotationTraySendOpenChange = useCallback(
    (open: boolean): void => {
      setAnnotationTraySendOpen(open)
      if (open) {
        openAgentSendPopoverTargetMode({
          id: annotationTraySendModeId,
          worktreeId,
          source: 'browser-annotations',
          prompt: browserAnnotationsPrompt,
          label: translate(
            'auto.components.browser.pane.BrowserPane.27d863542c',
            'Browser annotations'
          ),
          launchSource: 'notes_send'
        })
      } else {
        closeAgentSendPopoverTargetMode(annotationTraySendModeId)
      }
    },
    [
      annotationTraySendModeId,
      browserAnnotationsPrompt,
      closeAgentSendPopoverTargetMode,
      openAgentSendPopoverTargetMode,
      worktreeId
    ]
  )

  useEffect(() => {
    if (annotationBannerSendOpen && activeAgentSendTargetModeId !== annotationBannerSendModeId) {
      setAnnotationBannerSendOpen(false)
    }
    if (annotationTraySendOpen && activeAgentSendTargetModeId !== annotationTraySendModeId) {
      setAnnotationTraySendOpen(false)
    }
  }, [
    activeAgentSendTargetModeId,
    annotationBannerSendModeId,
    annotationBannerSendOpen,
    annotationTraySendModeId,
    annotationTraySendOpen
  ])

  useEffect(
    () => () => {
      closeAgentSendPopoverTargetMode(annotationBannerSendModeId)
      closeAgentSendPopoverTargetMode(annotationTraySendModeId)
    },
    [annotationBannerSendModeId, annotationTraySendModeId, closeAgentSendPopoverTargetMode]
  )

  const handleCopyBrowserAnnotations = useCallback((): void => {
    if (!browserAnnotationsPrompt) {
      return
    }
    void window.api.ui.writeClipboardText(browserAnnotationsPrompt)
    recordFeatureInteraction('browser-annotations')
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(true)
    annotationCopyTimerRef.current = setTimeout(() => setBrowserAnnotationsCopied(false), 1400)
  }, [browserAnnotationsPrompt, recordFeatureInteraction])

  const handleBrowserAnnotationsSentToAgent = useCallback((): void => {
    recordFeatureInteraction('browser-annotations-sent-to-agent')
  }, [recordFeatureInteraction])

  const handleClearBrowserAnnotations = useCallback((): void => {
    if (browserAnnotationsRef.current.length === 0) {
      return
    }
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(false)
    recordFeatureInteraction('browser-annotations')
    clearBrowserPageAnnotations(browserTabId)
  }, [browserTabId, clearBrowserPageAnnotations, recordFeatureInteraction])

  const handleDeleteBrowserAnnotation = useCallback(
    (annotationId: string): void => {
      deleteBrowserPageAnnotation(browserTabId, annotationId)
      recordFeatureInteraction('browser-annotations')
    },
    [browserTabId, deleteBrowserPageAnnotation, recordFeatureInteraction]
  )

  return {
    browserAnnotations,
    browserAnnotationsPrompt,
    browserAnnotationTrayOpen,
    setBrowserAnnotationTrayOpen,
    browserAnnotationsCopied,
    annotationBannerSendOpen,
    annotationTraySendOpen,
    handleAnnotationBannerSendOpenChange,
    handleAnnotationTraySendOpenChange,
    handleCopyBrowserAnnotations,
    handleClearBrowserAnnotations,
    handleDeleteBrowserAnnotation,
    handleBrowserAnnotationsSentToAgent,
    activeGroupId
  }
}
