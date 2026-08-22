import { useRef } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRestartRequiredNotice } from './SettingsRestartRequiredNotice'
import { SettingsSwitchRow } from './SettingsFormControls'

type MacAccentMenuSettingProps = {
  settings: Pick<GlobalSettings, 'macAccentMenuEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/**
 * macOS shows the accent picker on press-and-hold unless an app opts out for its own preferences
 * domain, which is why Orca opts out and held keys repeat (#14746). This is the way back.
 *
 * The preference is per-application, not per-view, so it reaches every text surface in Orca.
 */
export function MacAccentMenuSetting({
  settings,
  updateSettings
}: MacAccentMenuSettingProps): React.JSX.Element {
  const enabled = settings.macAccentMenuEnabled ?? false
  // Why: the write goes through a separate `defaults` process, so this app's own cached copy may
  // not see it until relaunch. Whether AppKit itself re-reads sooner is untested.
  const enabledAtMountRef = useRef<boolean>(enabled)
  const pendingRestart = enabled !== enabledAtMountRef.current

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.MacAccentMenuSetting.title',
        'Character Accent Menu'
      )}
      description={translate(
        'auto.components.settings.MacAccentMenuSetting.description',
        'Hold a key to pick an accented character instead of repeating it. Applies everywhere in Orca and requires restart.'
      )}
      keywords={[
        'accent',
        'accents',
        'diacritic',
        'press and hold',
        'press-and-hold',
        'key repeat',
        'repeat',
        'hold',
        'mac',
        'macos',
        'keyboard',
        'vim'
      ]}
      className="space-y-3 py-2"
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.MacAccentMenuSetting.title',
          'Character Accent Menu'
        )}
        description={translate(
          'auto.components.settings.MacAccentMenuSetting.description',
          'Hold a key to pick an accented character instead of repeating it. Applies everywhere in Orca and requires restart.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ macAccentMenuEnabled: !enabled })}
      />

      {pendingRestart ? (
        <SettingsRestartRequiredNotice
          description={translate(
            'auto.components.settings.MacAccentMenuSetting.restart',
            'Restart Orca to apply the accent menu change.'
          )}
        />
      ) : null}
    </SearchableSetting>
  )
}
