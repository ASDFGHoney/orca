import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isRemoteBrowserMethodUnsupportedError } from './remote-browser-stream-errors'
import type {
  RemoteBrowserPressState,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

const CALL_OPTIONS = { timeoutMs: 15_000, suppressFeatureInteraction: true }

// Why one atomic mouseClick when the pair is a plain click: the move/down/up chain costs three
// serialized round trips, visibly hovers on the way, and can miss small controls. Drags and
// modified clicks still need the chain, which is also the fallback for hosts predating mouseClick.
export async function sendRemoteBrowserClick({
  target,
  params,
  press,
  release,
  preferAtomicClick,
  onAtomicClickUnsupported
}: {
  target: RemoteBrowserRuntimeTarget
  params: { worktree: string; page: string }
  press: RemoteBrowserPressState
  release: RemoteBrowserPressState
  preferAtomicClick: boolean
  onAtomicClickUnsupported: () => void
}): Promise<void> {
  if (preferAtomicClick) {
    try {
      await callRuntimeRpc(
        target,
        'browser.mouseClick',
        { ...params, x: release.point.x, y: release.point.y, button: release.button },
        CALL_OPTIONS
      )
      return
    } catch (error) {
      if (!isRemoteBrowserMethodUnsupportedError(error)) {
        throw error
      }
      onAtomicClickUnsupported()
    }
  }
  await callRuntimeRpc(
    target,
    'browser.mouseMove',
    { ...params, x: press.point.x, y: press.point.y },
    CALL_OPTIONS
  )
  await callRuntimeRpc(
    target,
    'browser.mouseDown',
    { ...params, button: press.button },
    CALL_OPTIONS
  )
  if (press.point.x !== release.point.x || press.point.y !== release.point.y) {
    await callRuntimeRpc(
      target,
      'browser.mouseMove',
      { ...params, x: release.point.x, y: release.point.y },
      CALL_OPTIONS
    )
  }
  await callRuntimeRpc(
    target,
    'browser.mouseUp',
    { ...params, button: release.button },
    CALL_OPTIONS
  )
}
