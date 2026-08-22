import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Separator } from '../ui/separator'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  getManageSessionsSearchEntries,
  getTerminalAdvancedSearchEntries,
  getTerminalMacAccentMenuSearchEntries,
  getTerminalMacOptionSearchEntries,
  getTerminalMacYenSearchEntries,
  getTerminalPaneInteractionSearchEntries,
  getTerminalRenderingSearchEntries,
  getTerminalSetupScriptSearchEntries
} from './terminal-search'
import {
  getTerminalRightClickToPasteSearchEntry,
  getTerminalWindowsPowershellImplementationSearchEntry,
  getTerminalWindowsShellSearchEntry
} from './terminal-windows-search'
import { ManageSessionsSection } from './ManageSessionsSection'
import { TerminalAdvancedSection } from './TerminalAdvancedSection'
import { TerminalInteractionSection } from './TerminalInteractionSection'
import { TerminalRenderingSection } from './TerminalRenderingSection'
import { TerminalSetupScriptSection } from './TerminalSetupScriptSection'
import { TerminalWindowsShellSection } from './TerminalWindowsShellSection'

type TerminalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  scrollbackMode: 'preset' | 'custom'
  setScrollbackMode: (mode: 'preset' | 'custom') => void
  /** Deprecated: WSL selection now belongs to Project Runtime settings. */
  wslAvailable?: boolean
  /** Deprecated: WSL selection now belongs to Project Runtime settings. */
  wslDistros?: string[]
  /** Deprecated: WSL selection now belongs to Project Runtime settings. */
  wslCapabilitiesLoading?: boolean
  /** Whether PowerShell 7+ (pwsh.exe) is installed on this Windows machine. */
  pwshAvailable?: boolean
  /** Whether Git for Windows bash.exe is installed on this machine. */
  gitBashAvailable?: boolean
  /** Whether the active terminal host is Windows, even if the client is not. */
  isWindowsTerminalHost?: boolean
}

export function TerminalPane({
  settings,
  updateSettings,
  scrollbackMode,
  setScrollbackMode,
  pwshAvailable,
  gitBashAvailable = false,
  isWindowsTerminalHost
}: TerminalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isWindows = isWindowsUserAgent()
  const showWindowsHostSettings = isWindowsTerminalHost ?? isWindows
  const isMac = isMacUserAgent()
  // Why not isMac alone: the accent-menu opt-out is a macOS preference written by this machine's
  // own desktop app, so a web client would show a control it cannot apply.
  const isDesktopMac = isMac && !isWebClientLocation()
  const windowsShell = settings.terminalWindowsShell ?? 'powershell.exe'
  const showWindowsPowerShellImplementation =
    showWindowsHostSettings && windowsShell === 'powershell.exe'

  const visibleSections = [
    showWindowsHostSettings &&
    matchesSettingsSearch(searchQuery, getTerminalWindowsShellSearchEntry()) ? (
      <TerminalWindowsShellSection
        key="windows-shell"
        updateSettings={updateSettings}
        windowsShell={windowsShell}
        gitBashAvailable={gitBashAvailable}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalRenderingSearchEntries()) ? (
      <TerminalRenderingSection
        key="rendering"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalPaneInteractionSearchEntries()) ||
    matchesSettingsSearch(searchQuery, getTerminalRightClickToPasteSearchEntry()) ? (
      <TerminalInteractionSection
        key="pane-interaction"
        settings={settings}
        updateSettings={updateSettings}
        searchQuery={searchQuery}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalSetupScriptSearchEntries()) ? (
      <TerminalSetupScriptSection
        key="setup-script"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getManageSessionsSearchEntries()) ? (
      <ManageSessionsSection key="manage-sessions" />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalAdvancedSearchEntries()) ||
    (showWindowsPowerShellImplementation &&
      matchesSettingsSearch(
        searchQuery,
        getTerminalWindowsPowershellImplementationSearchEntry()
      )) ||
    (isMac &&
      (matchesSettingsSearch(searchQuery, getTerminalMacOptionSearchEntries()) ||
        matchesSettingsSearch(searchQuery, getTerminalMacYenSearchEntries()))) ||
    (isDesktopMac &&
      matchesSettingsSearch(searchQuery, getTerminalMacAccentMenuSearchEntries())) ? (
      <TerminalAdvancedSection
        key="advanced"
        settings={settings}
        updateSettings={updateSettings}
        scrollbackMode={scrollbackMode}
        setScrollbackMode={setScrollbackMode}
        searchQuery={searchQuery}
        showWindowsPowerShellImplementation={showWindowsPowerShellImplementation}
        pwshAvailable={pwshAvailable}
        isMac={isMac}
        isDesktopMac={isDesktopMac}
      />
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-6">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
