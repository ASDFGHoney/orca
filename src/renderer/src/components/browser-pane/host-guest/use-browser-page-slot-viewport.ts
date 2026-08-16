import { useLayoutEffect, useState } from 'react'
import {
  getBrowserOverlaySlotViewport,
  subscribeBrowserOverlaySlotViewport
} from './browser-page-viewport'

export function useBrowserPageSlotViewport(workspaceId: string): boolean {
  const [slotViewportReady, setSlotViewportReady] = useState(
    () => getBrowserOverlaySlotViewport(workspaceId) !== null
  )
  useLayoutEffect(() => {
    if (getBrowserOverlaySlotViewport(workspaceId)) {
      setSlotViewportReady(true)
      return
    }
    return subscribeBrowserOverlaySlotViewport(workspaceId, () => {
      setSlotViewportReady(true)
    })
  }, [workspaceId])
  return slotViewportReady
}
