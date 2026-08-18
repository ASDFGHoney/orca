import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getBrowserClientHostedRemoteDescription,
  getBrowserClientHostedRemoteTitle
} from './browser-client-hosted-remote-copy'

type BrowserClientHostedRemoteSettingProps = {
  settings: Pick<GlobalSettings, 'browserClientHostedRemoteEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserClientHostedRemoteSetting({
  settings,
  updateSettings
}: BrowserClientHostedRemoteSettingProps): React.JSX.Element {
  const title = getBrowserClientHostedRemoteTitle()
  const description = getBrowserClientHostedRemoteDescription()

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'browser',
        'remote',
        'client',
        'host',
        'hosted',
        'desktop',
        'webview',
        'placement'
      ]}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        // Why: absent means on — profiles written before the flag existed default to client hosting.
        checked={settings.browserClientHostedRemoteEnabled !== false}
        onChange={() =>
          updateSettings({
            browserClientHostedRemoteEnabled: settings.browserClientHostedRemoteEnabled === false
          })
        }
      />
    </SearchableSetting>
  )
}
