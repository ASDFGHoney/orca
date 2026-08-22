export const COMPUTER_AWAKE_MODES = ['on', 'off', 'auto'] as const

export type ComputerAwakeMode = (typeof COMPUTER_AWAKE_MODES)[number]

/** Which macOS tool holds the wake assertion. Amphetamine is opt-in and only usable when installed. */
export const MACOS_AWAKE_ENGINES = ['caffeinate', 'amphetamine'] as const

export type MacosAwakeEngine = (typeof MACOS_AWAKE_ENGINES)[number]

export const DEFAULT_MACOS_AWAKE_ENGINE: MacosAwakeEngine = 'caffeinate'

/** Why Orca fell back to caffeinate: the app is missing, or its Automation grant was refused. */
export type AmphetamineUnavailableReason = 'not-installed' | 'automation-denied'

export type ComputerAwakeStatus = {
  mode: ComputerAwakeMode
  active: boolean
  /** Optional for mixed-version compatibility: hosts predating the engine choice omit it. */
  macosEngine?: MacosAwakeEngine
  /** Undefined until the host probes, and on every non-macOS host. */
  amphetamineInstalled?: boolean
  /** Set once Amphetamine was selected but could not hold the session; Orca is running caffeinate instead. */
  amphetamineUnavailableReason?: AmphetamineUnavailableReason
}

export function normalizeComputerAwakeMode(
  mode: unknown,
  legacyAutoEnabled?: boolean
): ComputerAwakeMode {
  const explicitMode = COMPUTER_AWAKE_MODES.includes(mode as ComputerAwakeMode)
    ? (mode as ComputerAwakeMode)
    : null
  if (!explicitMode) {
    return legacyAutoEnabled === true ? 'auto' : 'off'
  }
  if (typeof legacyAutoEnabled === 'boolean' && legacyAutoEnabled !== (explicitMode !== 'off')) {
    // Older builds can only change the legacy boolean, so disagreement means it was written later.
    return legacyAutoEnabled ? 'auto' : 'off'
  }
  return explicitMode
}

export function normalizeMacosAwakeEngine(engine: unknown): MacosAwakeEngine {
  return MACOS_AWAKE_ENGINES.includes(engine as MacosAwakeEngine)
    ? (engine as MacosAwakeEngine)
    : DEFAULT_MACOS_AWAKE_ENGINE
}

export function computerAwakeSettingsForMode(mode: ComputerAwakeMode): {
  computerAwakeMode: ComputerAwakeMode
  keepComputerAwakeWhileAgentsRun: boolean
} {
  return {
    computerAwakeMode: mode,
    // Older Orca versions approximate On with their supported Auto behavior.
    keepComputerAwakeWhileAgentsRun: mode !== 'off'
  }
}

export function computerAwakeSettingsForMacosEngine(engine: MacosAwakeEngine): {
  computerAwakeMacosEngine: MacosAwakeEngine
} {
  return { computerAwakeMacosEngine: normalizeMacosAwakeEngine(engine) }
}
