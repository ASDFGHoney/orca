import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * A client-hosted page's popups are gesture-gated and capped, and every denial returns null to the
 * page with no other trace. One quiet toast per page and origin says the click was refused, without
 * spamming a site that retries.
 */
export function useBrowserClientHostedPopupNotices(browserPageId: string): void {
  useEffect(() => {
    return window.api.browser.onPopup((event) => {
      if (event.browserPageId !== browserPageId || event.action !== 'blocked') {
        return
      }
      toast.message(
        translate('browser.clientHosted.popupBlocked', 'Popup blocked: {{origin}}', {
          origin: event.origin
        }),
        { id: `browser-popup-blocked:${browserPageId}:${event.origin}` }
      )
    })
  }, [browserPageId])
}
