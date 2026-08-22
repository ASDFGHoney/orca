import { Coffee, Pill } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { ComputerAwakeStatus, MacosAwakeEngine } from '../../../../shared/computer-awake-mode'

export const AMPHETAMINE_APP_STORE_URL = 'https://apps.apple.com/app/amphetamine/id937984704'

function openAmphetamineListing(): void {
  void window.api.shell.openUrl(AMPHETAMINE_APP_STORE_URL)
}

type EngineOptionProps = {
  icon: LucideIcon
  label: string
  title: string
  body: string
  hint?: string
  selected: boolean
  /** Present the option but route the click to installing it instead of selecting it. */
  unavailable?: boolean
  onSelect: () => void
}

function EngineOption({
  icon: Icon,
  label,
  title,
  body,
  hint,
  selected,
  unavailable,
  onSelect
}: EngineOptionProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          aria-label={label}
          onClick={onSelect}
          className={`flex flex-1 cursor-pointer flex-col items-center gap-1 rounded-md border px-2 py-2 transition-colors ${
            selected
              ? 'border-border bg-accent text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          } ${unavailable ? 'opacity-60' : ''}`}
        >
          <Icon className="size-4" />
          <span className="text-[11px] font-medium">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-64 py-2">
        <span className="block font-medium">{title}</span>
        {/* Why not text-muted-foreground: the tooltip surface is inverted
            (bg-foreground), so a light-surface grey renders unreadable on it.
            De-emphasize with opacity of the inherited color instead. */}
        <span className="mt-0.5 block text-background/75">{body}</span>
        {hint ? <span className="mt-1.5 block text-background/75">{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export function AwakeEnginePicker({
  engine,
  status,
  onChange
}: {
  engine: MacosAwakeEngine
  status: ComputerAwakeStatus
  onChange: (engine: MacosAwakeEngine) => void
}): React.JSX.Element {
  const notInstalled = status.amphetamineInstalled === false
  const automationDenied = status.amphetamineUnavailableReason === 'automation-denied'

  const amphetamineBody = notInstalled
    ? translate(
        'auto.components.status.bar.AwakeEnginePicker.amphetamineMissingBody',
        'Keep running with the lid shut. Auto-start on power or an app. Control the display and screen saver.'
      )
    : translate(
        'auto.components.status.bar.AwakeEnginePicker.amphetamineBody',
        'Uses the Amphetamine Mac app. Control the display and screen saver, and auto-start on power or an app.'
      )

  const amphetamineHint = notInstalled
    ? translate(
        'auto.components.status.bar.AwakeEnginePicker.amphetamineGet',
        "Click to open the Mac App Store. It's free."
      )
    : automationDenied
      ? translate(
          'auto.components.status.bar.AwakeEnginePicker.amphetamineDenied',
          'Orca is using Caffeinate. Allow Orca in System Settings › Privacy & Security › Automation.'
        )
      : translate(
          'auto.components.status.bar.AwakeEnginePicker.amphetamineSafety',
          'Orca never replaces or ends a session you started.'
        )

  return (
    <div
      role="radiogroup"
      aria-label={translate(
        'auto.components.status.bar.AwakeEnginePicker.label',
        'Keep awake engine'
      )}
      className="flex gap-1 px-1 pb-1"
    >
      <EngineOption
        icon={Coffee}
        label={translate('auto.components.status.bar.AwakeEnginePicker.caffeinate', 'Caffeinate')}
        title={translate(
          'auto.components.status.bar.AwakeEnginePicker.caffeinateTitle',
          'Built into macOS'
        )}
        body={translate(
          'auto.components.status.bar.AwakeEnginePicker.caffeinateBody',
          'A private macOS process Orca starts and stops. Nothing to install, and it touches nothing else.'
        )}
        selected={engine === 'caffeinate'}
        onSelect={() => onChange('caffeinate')}
      />
      <EngineOption
        icon={Pill}
        label={translate('auto.components.status.bar.AwakeEnginePicker.amphetamine', 'Amphetamine')}
        title={translate(
          'auto.components.status.bar.AwakeEnginePicker.amphetamineTitle',
          'Works with the lid shut'
        )}
        body={amphetamineBody}
        hint={amphetamineHint}
        selected={engine === 'amphetamine'}
        unavailable={notInstalled}
        onSelect={() => (notInstalled ? openAmphetamineListing() : onChange('amphetamine'))}
      />
    </div>
  )
}
