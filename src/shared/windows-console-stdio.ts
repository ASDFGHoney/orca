import { closeSync as fsCloseSync, openSync as fsOpenSync } from 'node:fs'
import type { StdioOptions } from 'node:child_process'

export const WINDOWS_CONSOLE_INPUT_DEVICE = '\\\\.\\CONIN$'
export const WINDOWS_CONSOLE_OUTPUT_DEVICE = '\\\\.\\CONOUT$'

export type WindowsInteractiveStdio = {
  stdio: [number, number, number]
  dispose: () => void
}

type OpenWindowsInteractiveStdioDeps = {
  platform?: NodeJS.Platform
  openSync?: (path: string, flags: string) => number
  closeSync?: (fd: number) => void
}

function closeUniqueFds(fds: number[], close: typeof fsCloseSync): void {
  for (const fd of new Set(fds)) {
    try {
      close(fd)
    } catch {
      // Already closed by a previous dispose or a failed partial open.
    }
  }
}

/**
 * Opens the Windows console devices so an interactive child of a GUI-subsystem
 * Electron CLI can actually read typed input. Do not trust `stdin.isTTY`.
 */
export function openWindowsInteractiveStdio(
  deps: OpenWindowsInteractiveStdioDeps = {}
): WindowsInteractiveStdio | 'inherit' {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return 'inherit'
  }
  const openSync = deps.openSync ?? ((path: string, flags: string) => fsOpenSync(path, flags))
  const closeSync = deps.closeSync ?? fsCloseSync
  const opened: number[] = []
  try {
    opened.push(openSync(WINDOWS_CONSOLE_INPUT_DEVICE, 'r+'))
    opened.push(openSync(WINDOWS_CONSOLE_OUTPUT_DEVICE, 'w'))
    const [stdin, stdout] = opened
    let disposed = false
    return {
      stdio: [stdin, stdout, stdout],
      dispose: () => {
        if (disposed) {
          return
        }
        disposed = true
        closeUniqueFds(opened, closeSync)
      }
    }
  } catch {
    closeUniqueFds(opened, closeSync)
    return 'inherit'
  }
}

export function stdioForWindowsInteractiveChild(
  json: boolean,
  deps: OpenWindowsInteractiveStdioDeps = {}
): { stdio: StdioOptions; dispose: () => void } {
  const opened = openWindowsInteractiveStdio(deps)
  if (opened === 'inherit') {
    return {
      stdio: ['inherit', json ? process.stderr : 'inherit', 'inherit'],
      dispose: () => {}
    }
  }
  return {
    stdio: [opened.stdio[0], json ? process.stderr : opened.stdio[1], opened.stdio[2]],
    dispose: opened.dispose
  }
}
