import type { WebContents } from 'electron'
import { closeRouteGuest } from './browser-route-guest-guard'

export function enforceBrowserRouteWebRtcPolicy(guest: WebContents): boolean {
  try {
    guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    return true
  } catch {
    closeRouteGuest(guest)
    return false
  }
}
