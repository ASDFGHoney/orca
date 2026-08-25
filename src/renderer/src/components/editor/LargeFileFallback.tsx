import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  megabytesLabel,
  type FileTooLargeDetails
} from '../../../../shared/editor-file-read-limits'

export function LargeFileFallback({
  details,
  onRetry
}: {
  details: FileTooLargeDetails
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="large-file-fallback"
      className="flex h-full items-center justify-center bg-editor-surface p-6 text-muted-foreground"
    >
      <div className="max-w-xl space-y-3 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.editor.LargeFileFallback.0aabd49594',
            'This file is too large to open in the editor.'
          )}
        </div>
        <div className="grid gap-1 text-xs sm:grid-cols-2 sm:text-left">
          <div>
            {translate('auto.components.editor.LargeFileFallback.64689ffd03', 'Size')}:{' '}
            {megabytesLabel(details.observedMb, 1)}
          </div>
          <div>
            {translate('auto.components.editor.LargeFileFallback.a66faf5b54', 'Editor limit')}:{' '}
            {megabytesLabel(details.limitMb)}
          </div>
        </div>
        <div className="text-xs">
          {translate(
            'auto.components.editor.LargeFileFallback.e13c1c94e0',
            'Files this large are not loaded into the editor, so the window stays responsive. Open it in an external editor, or split it before editing.'
          )}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          {translate('auto.components.editor.LargeFileFallback.e51e6a81c9', 'Try again')}
        </Button>
      </div>
    </div>
  )
}
