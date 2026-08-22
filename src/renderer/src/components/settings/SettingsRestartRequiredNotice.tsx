import { useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from '../ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type SettingsRestartRequiredNoticeProps = {
  /** What the restart will apply, phrased for the setting that changed. */
  description: string
}

/** Inline banner for settings only read once at startup. Keys are the originals from the window
 *  blur notice this was extracted from, so the existing translations still resolve. */
export function SettingsRestartRequiredNotice({
  description
}: SettingsRestartRequiredNoticeProps): React.JSX.Element {
  const [relaunching, setRelaunching] = useState(false)
  const mountedRef = useMountedRef()

  const handleRelaunch = async (): Promise<void> => {
    if (relaunching) {
      return
    }
    setRelaunching(true)
    try {
      await window.api.app.relaunch()
    } catch {
      if (mountedRef.current) {
        setRelaunching(false)
      }
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
          {translate(
            'auto.components.settings.TerminalWindowSection.c65bb9ce63',
            'Restart required'
          )}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button
        size="sm"
        variant="default"
        className="shrink-0 gap-1.5"
        disabled={relaunching}
        onClick={() => void handleRelaunch()}
      >
        <RotateCw className={`size-3 ${relaunching ? 'animate-spin' : ''}`} />
        {relaunching
          ? translate('auto.components.settings.TerminalWindowSection.907131d741', 'Restarting…')
          : translate('auto.components.settings.TerminalWindowSection.8abdab9f7c', 'Restart now')}
      </Button>
    </div>
  )
}
