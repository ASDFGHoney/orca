import { getPosixOmpShellWrapper } from '../pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import {
  getZshFinalZdotdirRestoreBlock,
  getZshOsc133RegistrationBlock,
  getZshStartupFileSourceBlock,
  ZSH_HISTFILE_RESTORE_BLOCK
} from '../shell-templates'

export function getDaemonZshShellReadyRcfileContent(): string {
  return `# Orca daemon zsh shell-ready wrapper
${getZshStartupFileSourceBlock({
  fileName: '.zshrc',
  interactiveOnly: true,
  skipWhenHomeIsCurrentZdotdir: true
})}
__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_AGENT_TEAMS_SHIM_DIR}"|"\${ORCA_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
[[ ! -o login ]] && __orca_restore_agent_teams_path
if [[ ! -o login ]]; then
  # Why: ~/.zshrc can export the user's default OpenCode config after spawn.
  [[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
  [[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
  ${getPosixOmpShellWrapper()}
  [[ -n "\${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="\${ORCA_CODEX_HOME}"
${ZSH_HISTFILE_RESTORE_BLOCK}
  ${getPosixCodexShellLaunchPreflight()}
fi
${getZshOsc133RegistrationBlock()}
if [[ ! -o login ]]; then
${getZshFinalZdotdirRestoreBlock()}
fi
`
}
