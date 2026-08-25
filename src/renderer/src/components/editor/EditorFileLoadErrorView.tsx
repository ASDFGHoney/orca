import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { parseFileTooLargeMessage } from '../../../../shared/editor-file-read-limits'
import { LargeFileFallback } from './LargeFileFallback'

export function EditorFileLoadErrorView({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  // Why: an oversized file is a known limit, not a failure — say so instead of an error card with no next step.
  const tooLarge = parseFileTooLargeMessage(message)
  if (tooLarge) {
    return <LargeFileFallback details={tooLarge} onRetry={onRetry} />
  }

  return (
    <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
      <div className="flex max-w-xl items-start gap-3 rounded-md border border-border bg-background p-4">
        <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {translate('auto.components.editor.EditorContent.39f018b052', 'Unable to load file')}
          </div>
          <div className="mt-1 break-words">{message}</div>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {translate('auto.components.editor.EditorContent.2a512bb46a', 'Retry')}
          </Button>
        </div>
      </div>
    </div>
  )
}
