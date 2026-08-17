export type RemoteBrowserPointerButton = 'left' | 'middle'

export type RemoteBrowserPointerModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

export type RemoteBrowserPointerSample = {
  pointerId: number
  x: number
  y: number
  button: RemoteBrowserPointerButton
  modifiers: RemoteBrowserPointerModifier[]
}

export type RemoteBrowserPointerCommand =
  | {
      method: 'browser.mouseClick'
      params: {
        x: number
        y: number
        button: RemoteBrowserPointerButton
        modifiers: RemoteBrowserPointerModifier[]
      }
    }
  | {
      method: 'browser.mouseMove'
      params: { x: number; y: number }
    }
  | {
      method: 'browser.mouseDown' | 'browser.mouseUp'
      params: { button: RemoteBrowserPointerButton }
    }

const REMOTE_BROWSER_DRAG_THRESHOLD_PX = 6

export function isRemoteBrowserPointerDrag(
  start: RemoteBrowserPointerSample,
  end: Pick<RemoteBrowserPointerSample, 'pointerId' | 'x' | 'y'>
): boolean {
  return (
    start.pointerId === end.pointerId &&
    Math.hypot(end.x - start.x, end.y - start.y) > REMOTE_BROWSER_DRAG_THRESHOLD_PX
  )
}

export function getRemoteBrowserPointerCommands(
  start: RemoteBrowserPointerSample,
  end: Pick<RemoteBrowserPointerSample, 'pointerId' | 'x' | 'y'>
): RemoteBrowserPointerCommand[] | null {
  if (start.pointerId !== end.pointerId) {
    return null
  }
  const isDrag = isRemoteBrowserPointerDrag(start, end)
  if (!isDrag) {
    return [
      {
        method: 'browser.mouseClick',
        params: {
          x: end.x,
          y: end.y,
          button: start.button,
          modifiers: start.modifiers
        }
      }
    ]
  }
  return [
    { method: 'browser.mouseMove', params: { x: start.x, y: start.y } },
    { method: 'browser.mouseDown', params: { button: start.button } },
    { method: 'browser.mouseMove', params: { x: end.x, y: end.y } },
    { method: 'browser.mouseUp', params: { button: start.button } }
  ]
}
