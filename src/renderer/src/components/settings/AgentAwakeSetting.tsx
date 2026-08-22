import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import {
  getAgentAwakeDescription,
  getAgentAwakeEngineSearchKeywords,
  getAgentAwakeSearchKeywords,
  getAgentAwakeTitle
} from './agent-awake-copy'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl } from './SettingsFormControls'
import {
  computerAwakeSettingsForMacosEngine,
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode,
  normalizeMacosAwakeEngine,
  type AmphetamineUnavailableReason,
  type ComputerAwakeMode,
  type ComputerAwakeStatus,
  type MacosAwakeEngine
} from '../../../../shared/computer-awake-mode'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { translate } from '@/i18n/i18n'

type AgentAwakeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Live engine availability from the main process; the caller owns the subscription. */
  awakeStatus?: ComputerAwakeStatus
}

export function AgentAwakeSetting({
  settings,
  updateSettings,
  awakeStatus
}: AgentAwakeSettingProps): React.JSX.Element {
  const title = getAgentAwakeTitle()
  const description = getAgentAwakeDescription()
  const mode = normalizeComputerAwakeMode(
    settings.computerAwakeMode,
    settings.keepComputerAwakeWhileAgentsRun
  )
  const isMac = getRendererAppPlatform() === 'darwin'
  const engine = normalizeMacosAwakeEngine(settings.computerAwakeMacosEngine)
  const engineTitle = translate(
    'auto.components.settings.AgentAwakeSetting.engineTitle',
    'Keep awake engine'
  )
  const engineDescription = getEngineDescription(
    awakeStatus?.amphetamineInstalled,
    awakeStatus?.amphetamineUnavailableReason
  )
  const setMode = (nextMode: ComputerAwakeMode): void => {
    updateSettings(computerAwakeSettingsForMode(nextMode))
  }
  const setEngine = (nextEngine: MacosAwakeEngine): void => {
    updateSettings(computerAwakeSettingsForMacosEngine(nextEngine))
  }

  return (
    <section className="space-y-3">
      <SearchableSetting
        title={title}
        description={description}
        keywords={getAgentAwakeSearchKeywords()}
      >
        <div className="flex items-start justify-between gap-4 py-2">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label>{title}</Label>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <SettingsSegmentedControl
            value={mode}
            onChange={setMode}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'on',
                label: translate('auto.components.settings.AgentAwakeSetting.on', 'On')
              },
              {
                value: 'auto',
                label: translate('auto.components.settings.AgentAwakeSetting.auto', 'Agent')
              },
              {
                value: 'off',
                label: translate('auto.components.settings.AgentAwakeSetting.off', 'Off')
              }
            ]}
          />
        </div>
      </SearchableSetting>
      {isMac ? (
        <SearchableSetting
          title={engineTitle}
          description={engineDescription}
          keywords={getAgentAwakeEngineSearchKeywords()}
        >
          <div className="flex items-start justify-between gap-4 py-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label>{engineTitle}</Label>
              <p className="text-xs text-muted-foreground">{engineDescription}</p>
            </div>
            <SettingsSegmentedControl
              value={engine}
              onChange={setEngine}
              ariaLabel={engineTitle}
              size="sm"
              options={[
                {
                  value: 'caffeinate',
                  label: translate(
                    'auto.components.settings.AgentAwakeSetting.caffeinate',
                    'Caffeinate'
                  )
                },
                {
                  value: 'amphetamine',
                  label: translate(
                    'auto.components.settings.AgentAwakeSetting.amphetamine',
                    'Amphetamine'
                  ),
                  disabled: awakeStatus?.amphetamineInstalled === false
                }
              ]}
            />
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}

function getEngineDescription(
  amphetamineInstalled: boolean | undefined,
  unavailableReason: AmphetamineUnavailableReason | undefined
): string {
  if (amphetamineInstalled === false) {
    return translate(
      'auto.components.settings.AgentAwakeSetting.engineDescriptionMissing',
      'Caffeinate is built into macOS. Install Amphetamine to hand the session to its triggers and app rules instead.'
    )
  }
  if (unavailableReason === 'automation-denied') {
    return translate(
      'auto.components.settings.AgentAwakeSetting.engineDescriptionDenied',
      'Orca is running Caffeinate because Amphetamine control was refused. Allow Orca under Privacy & Security › Automation.'
    )
  }
  return translate(
    'auto.components.settings.AgentAwakeSetting.engineDescription',
    'Caffeinate is built into macOS. Amphetamine hands the session to the app so its triggers and app rules apply.'
  )
}
