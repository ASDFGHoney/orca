import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { _resetLocalPtyProviderStateForTest } from './local-pty-provider'

export type LocalPtyExitCallback = (info: { exitCode: number }) => void

export type LocalPtyMockProcess = {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  process: string
  pid: number
}

export type LocalPtyProviderMocks = {
  existsSyncMock: Mock
  statSyncMock: Mock
  accessSyncMock: Mock
  mkdirSyncMock: Mock
  writeFileSyncMock: Mock
  prepareMacosTccLoginShellMock: Mock
  resolveAgentForegroundProcessMock: Mock
  readWindowsConptyProcessIdsMock: Mock
  killWithDescendantSweepMock: Mock
  isWslAvailableAsyncMock: Mock
  wslUncDirectoryExistsMock: Mock
  createShellPromptReadinessProbeMock: Mock
}

// Why cleared: the runner is usually itself a child of an Orca zsh pane, so these
// already sit in process.env and every spawn env inherits them. Left alone, a
// developer machine takes the wrapper branch and passes ZDOTDIR assertions that CI
// would fail — and injectHistoryEnv deliberately preserves an inherited HISTFILE.
const INHERITED_SHELL_ENV_KEYS = [
  'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD',
  'HISTFILE',
  'ORCA_HISTFILE',
  'ZDOTDIR',
  'ORCA_ORIG_ZDOTDIR',
  'ORCA_ZSHENV_SOURCE_DIR',
  'ORCA_SHELL_READY_MARKER',
  'ORCA_SHELL_STARTUP_IDENTITY',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_MIMOCODE_HOME',
  'ORCA_OMP_STATUS_EXTENSION',
  'ORCA_CODEX_HOME',
  'ORCA_AGENT_TEAMS_SHIM_DIR'
] as const

/** Pins platform/shell env for every test and restores it plus provider module state after. */
export function installLocalPtyProviderEnvSandbox(): void {
  let origShell: string | undefined
  let origInheritedShellEnv: Record<string, string | undefined> = {}
  let origPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    origShell = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    origInheritedShellEnv = {}
    for (const key of INHERITED_SHELL_ENV_KEYS) {
      origInheritedShellEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    _resetLocalPtyProviderStateForTest()
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    if (origShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = origShell
    }
    for (const [key, value] of Object.entries(origInheritedShellEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })
}

export function applyLocalPtyProviderMockDefaults(mocks: LocalPtyProviderMocks): void {
  mocks.existsSyncMock.mockReturnValue(true)
  mocks.statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
  mocks.accessSyncMock.mockReturnValue(undefined)
  mocks.mkdirSyncMock.mockReset()
  mocks.writeFileSyncMock.mockReset()
  mocks.killWithDescendantSweepMock.mockReset()
  // Default: no-op sweep that still runs killRoot (matches empty-snapshot degrade).
  mocks.killWithDescendantSweepMock.mockImplementation(
    async (_rootPid: number, killRoot: () => void, _deps?: { ownsRoot?: () => boolean }) => {
      killRoot()
    }
  )
  mocks.prepareMacosTccLoginShellMock.mockReset()
  mocks.prepareMacosTccLoginShellMock.mockResolvedValue(undefined)
  mocks.resolveAgentForegroundProcessMock.mockReset()
  mocks.resolveAgentForegroundProcessMock.mockImplementation(
    async (_pid: number, fallbackProcess: string | null) => ({
      available: true,
      processName: fallbackProcess
    })
  )
  mocks.readWindowsConptyProcessIdsMock.mockReset()
  mocks.readWindowsConptyProcessIdsMock.mockResolvedValue(null)
  mocks.isWslAvailableAsyncMock.mockReset()
  mocks.isWslAvailableAsyncMock.mockResolvedValue(true)
  mocks.wslUncDirectoryExistsMock.mockReset()
  mocks.wslUncDirectoryExistsMock.mockReturnValue(true)
  mocks.createShellPromptReadinessProbeMock.mockReset()
}

/** node-pty stand-in; the exit callback lives in the test file so bodies can fire it directly. */
export function createLocalPtyMockProcess(exitCallback: {
  get: () => LocalPtyExitCallback | undefined
  set: (cb: LocalPtyExitCallback | undefined) => void
}): LocalPtyMockProcess {
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((cb: LocalPtyExitCallback) => {
      exitCallback.set(cb)
      return {
        dispose: () => {
          if (exitCallback.get() === cb) {
            exitCallback.set(undefined)
          }
        }
      }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => {
      exitCallback.get()?.({ exitCode: -1 })
    }),
    process: 'zsh',
    pid: 12345
  }
}
