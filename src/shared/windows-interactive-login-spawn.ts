import { getSpawnArgsForWindows, wrapWindowsStartWait } from './windows-batch-spawn'
import { openWindowsInteractiveStdio, type WindowsInteractiveStdio } from './windows-console-stdio'

export type WindowsHostInteractiveLoginSpawn = {
  command: string
  args: string[]
  stdio: WindowsInteractiveStdio['stdio'] | 'ignore'
  windowsHide: boolean
  dispose: () => void
}

export function buildWindowsHostInteractiveLoginSpawn(
  command: string,
  args: string[],
  openStdio: typeof openWindowsInteractiveStdio = openWindowsInteractiveStdio
): WindowsHostInteractiveLoginSpawn {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  const opened = openStdio()
  if (opened !== 'inherit') {
    return {
      command: spawnCmd,
      args: spawnArgs,
      stdio: opened.stdio,
      windowsHide: false,
      dispose: opened.dispose
    }
  }
  const wrapped = wrapWindowsStartWait(spawnCmd, spawnArgs)
  return {
    command: wrapped.spawnCmd,
    args: wrapped.spawnArgs,
    stdio: 'ignore',
    windowsHide: true,
    dispose: () => {}
  }
}
