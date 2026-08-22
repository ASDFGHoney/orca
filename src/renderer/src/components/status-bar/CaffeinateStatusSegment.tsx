import { Coffee, Zap } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { useComputerAwakeStatus } from '@/hooks/computer-awake-status'
import { translate } from '@/i18n/i18n'
import {
  computerAwakeSettingsForMacosEngine,
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode,
  normalizeMacosAwakeEngine,
  type ComputerAwakeMode,
  type ComputerAwakeStatus,
  type MacosAwakeEngine
} from '../../../../shared/computer-awake-mode'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

function modeLabel(mode: ComputerAwakeMode): string {
  if (mode === 'on') {
    return translate('auto.components.status.bar.CaffeinateStatusSegment.on', 'On')
  }
  if (mode === 'auto') {
    return translate('auto.components.status.bar.CaffeinateStatusSegment.auto', 'Agent')
  }
  return translate('auto.components.status.bar.CaffeinateStatusSegment.off', 'Off')
}

function activityLabel(active: boolean): string {
  return active
    ? translate('auto.components.status.bar.CaffeinateStatusSegment.active', 'Active')
    : translate('auto.components.status.bar.CaffeinateStatusSegment.inactive', 'Inactive')
}

function engineLabel(engine: MacosAwakeEngine): string {
  return engine === 'amphetamine'
    ? translate('auto.components.status.bar.CaffeinateStatusSegment.amphetamine', 'Amphetamine')
    : translate('auto.components.status.bar.CaffeinateStatusSegment.title', 'Caffeinate')
}

/** Why not just "not installed": a refused Automation grant looks identical from the picker. */
function amphetamineDescription(status: ComputerAwakeStatus): string {
  if (status.amphetamineInstalled === false) {
    return translate(
      'auto.components.status.bar.CaffeinateStatusSegment.amphetamineMissing',
      'Not installed — get Amphetamine from the Mac App Store'
    )
  }
  if (status.amphetamineUnavailableReason === 'automation-denied') {
    return translate(
      'auto.components.status.bar.CaffeinateStatusSegment.amphetamineDenied',
      'Blocked — allow Orca under Privacy & Security › Automation'
    )
  }
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.amphetamineDescription',
    'Hand the session to Amphetamine so its triggers and app rules apply'
  )
}

export function CaffeinateStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const configuredMode = normalizeComputerAwakeMode(
    settings?.computerAwakeMode,
    settings?.keepComputerAwakeWhileAgentsRun
  )
  const configuredEngine = normalizeMacosAwakeEngine(settings?.computerAwakeMacosEngine)
  const serviceStatus = useComputerAwakeStatus()

  if (isPairedWebClientWindow()) {
    return null
  }

  const isMac = getRendererAppPlatform() === 'darwin'
  const mode = serviceStatus.mode === configuredMode ? serviceStatus.mode : configuredMode
  const active =
    serviceStatus.mode === configuredMode ? serviceStatus.active : configuredMode === 'on'
  // Only macOS runs an engine; everywhere else the segment keeps its Caffeinate identity.
  const engine = isMac ? configuredEngine : 'caffeinate'
  const amphetamineBlocked =
    serviceStatus.amphetamineInstalled === false ||
    serviceStatus.amphetamineUnavailableReason !== undefined
  const statusText = `${modeLabel(mode)} · ${activityLabel(active)}`
  const ariaLabel = translate(
    'auto.components.status.bar.CaffeinateStatusSegment.ariaLabelEngine',
    '{{engine}}, {{status}}',
    { engine: engineLabel(engine), status: statusText }
  )
  const EngineIcon = engine === 'amphetamine' ? Zap : Coffee

  const setMode = (nextMode: string): void => {
    void updateSettings(computerAwakeSettingsForMode(normalizeComputerAwakeMode(nextMode)))
  }

  const setEngine = (nextEngine: string): void => {
    void updateSettings(computerAwakeSettingsForMacosEngine(normalizeMacosAwakeEngine(nextEngine)))
  }

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              aria-label={ariaLabel}
            >
              <EngineIcon className={`size-3 ${active ? 'text-foreground' : ''}`} />
              {!iconOnly ? (
                <span className="text-[11px] font-medium">{modeLabel(mode)}</span>
              ) : null}
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${
                  active ? 'bg-foreground' : 'bg-muted-foreground/40'
                }`}
              />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {ariaLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="end"
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-3">
          <span>{engineLabel(engine)}</span>
          <span className="font-normal text-muted-foreground">{statusText}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={mode} onValueChange={setMode}>
          <DropdownMenuRadioItem value="on" className="py-1.5">
            <span className="flex flex-col">
              <span>{modeLabel('on')}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {translate(
                  'auto.components.status.bar.CaffeinateStatusSegment.onDescription',
                  'Keep this computer awake continuously'
                )}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="auto" className="py-1.5">
            <span className="flex flex-col">
              <span>{modeLabel('auto')}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {translate(
                  'auto.components.status.bar.CaffeinateStatusSegment.autoDescription',
                  'Stay awake while an agent is working'
                )}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" className="py-1.5">
            <span className="flex flex-col">
              <span>{modeLabel('off')}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {translate(
                  'auto.components.status.bar.CaffeinateStatusSegment.offDescription',
                  'Allow normal system sleep behavior'
                )}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {isMac ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
              {translate('auto.components.status.bar.CaffeinateStatusSegment.engine', 'Engine')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={engine} onValueChange={setEngine}>
              <DropdownMenuRadioItem value="caffeinate" className="py-1.5">
                <span className="flex flex-col">
                  <span>{engineLabel('caffeinate')}</span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {translate(
                      'auto.components.status.bar.CaffeinateStatusSegment.caffeinateDescription',
                      'Built into macOS — blocks idle and system sleep'
                    )}
                  </span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="amphetamine"
                className="py-1.5"
                disabled={serviceStatus.amphetamineInstalled === false}
              >
                <span className="flex flex-col">
                  <span>{engineLabel('amphetamine')}</span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {amphetamineDescription(serviceStatus)}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {engine === 'amphetamine' && amphetamineBlocked ? (
              <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.status.bar.CaffeinateStatusSegment.amphetamineFallback',
                  'Using Caffeinate until Amphetamine is available.'
                )}
              </p>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
