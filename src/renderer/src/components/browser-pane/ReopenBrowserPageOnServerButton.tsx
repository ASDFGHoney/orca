import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { reopenBrowserPageOnServer } from './browser-reopen-on-server'

export function reopenOnServerLabel(): string {
  return translate('browser.reopenOnServer.action', 'Reopen on server')
}

/** Honest about what a new page cannot carry over: it is not a migration. */
export function reopenOnServerCaveat(): string {
  return translate(
    'browser.reopenOnServer.caveat',
    'This opens a new page on the remote host at this page’s last address. Signed-in and other transient page state may differ, and a page that came from a form submission opens blank.'
  )
}

export function ReopenBrowserPageOnServerButton({
  environmentId,
  worktreeId,
  lastCommittedUrl,
  className
}: {
  environmentId: string
  worktreeId: string
  lastCommittedUrl: string | null | undefined
  className?: string
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const reopen = useCallback(() => {
    setPending(true)
    void reopenBrowserPageOnServer({ environmentId, worktreeId, lastCommittedUrl })
      .then((created) => {
        if (!created) {
          toast.error(
            translate(
              'browser.reopenOnServer.failed',
              "Couldn't open this page on the remote host. Check the connection and try again."
            )
          )
        }
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setPending(false))
  }, [environmentId, lastCommittedUrl, worktreeId])

  return (
    <Button
      size="sm"
      variant="secondary"
      className={className}
      disabled={pending}
      title={reopenOnServerCaveat()}
      onClick={reopen}
    >
      {reopenOnServerLabel()}
    </Button>
  )
}
