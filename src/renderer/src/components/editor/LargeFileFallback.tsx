import { translate } from '@/i18n/i18n'
import type { FileTooLargeDetail } from '../../../../shared/editor-file-read-limit'

const numberFormatter = new Intl.NumberFormat()

function formatMegabytes(bytes: number): string {
  return `${numberFormatter.format(Math.round((bytes / 1024 / 1024) * 10) / 10)} MB`
}

function describeLimitOwner(scope: FileTooLargeDetail['scope']): string {
  if (scope === 'ssh') {
    return translate(
      'auto.components.editor.LargeFileFallback.scopeSsh',
      'Files read over SSH share the connection with your terminals, so they use a smaller budget than local files.'
    )
  }
  if (scope === 'runtime') {
    return translate(
      'auto.components.editor.LargeFileFallback.scopeRuntime',
      'Files read from a remote workspace travel over the workspace connection, so they use a smaller budget than local files.'
    )
  }
  return translate(
    'auto.components.editor.LargeFileFallback.scopeLocal',
    'Local files use the largest budget Orca offers; beyond it the editor cannot hold the whole file in memory safely.'
  )
}

export function LargeFileFallback({
  filePath,
  detail
}: {
  filePath: string
  detail: FileTooLargeDetail
}): React.JSX.Element {
  return (
    <div
      data-testid="large-file-fallback"
      className="flex h-full min-h-[120px] items-center justify-center border border-border bg-muted/10 px-4 py-6 text-muted-foreground"
    >
      <div className="max-w-xl space-y-3 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.editor.LargeFileFallback.title',
            'This file is too large to open in the editor.'
          )}
        </div>
        <div className="break-all text-xs">{filePath}</div>
        <div className="grid gap-1 text-xs sm:grid-cols-2 sm:text-left">
          <div>
            {translate('auto.components.editor.LargeFileFallback.size', 'File size')}:{' '}
            {formatMegabytes(detail.byteLength)}
          </div>
          <div>
            {translate('auto.components.editor.LargeFileFallback.limit', 'Read limit')}:{' '}
            {formatMegabytes(detail.limitBytes)}
          </div>
        </div>
        <div className="text-[11px]">{describeLimitOwner(detail.scope)}</div>
      </div>
    </div>
  )
}
