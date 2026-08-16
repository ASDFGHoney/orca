import type { WslTranscriptFsReusableProcessCall } from './wsl-transcript-fs-process-protocol'
import {
  wslTranscriptFsHandleOwners,
  WslTranscriptFsProcessClient,
  type WslTranscriptFsProcessHandle
} from './wsl-transcript-fs-process-client'
import { forkWslTranscriptFsProcess } from './wsl-transcript-fs-process-spawn'

export type { WslTranscriptFsProcessHandle } from './wsl-transcript-fs-process-client'

// Why: an env-only check would let a leaked VITEST=true (harnesses spreading
// process.env into a real app) silently revert production to in-process UNC
// syscalls; the worker global only exists inside an actual vitest runtime.
function inVitestWorker(): boolean {
  return process.env.VITEST === 'true' && '__vitest_worker__' in globalThis
}

let sharedClient: WslTranscriptFsProcessClient | null = null

export function runWslTranscriptFsProcess<T>(
  request: WslTranscriptFsReusableProcessCall,
  signal: AbortSignal,
  testFallback?: () => Promise<T>
): Promise<T> {
  // Unit suites inject filesystem stalls directly; production never bypasses the process boundary.
  if (testFallback && inVitestWorker()) {
    return testFallback()
  }
  sharedClient ??= new WslTranscriptFsProcessClient(forkWslTranscriptFsProcess)
  return sharedClient.run<T>(request, signal)
}

export function openWslTranscriptFsProcess<T>(
  path: string,
  signal: AbortSignal,
  testFallback?: () => Promise<T>
): Promise<WslTranscriptFsProcessHandle | T> {
  if (testFallback && inVitestWorker()) {
    return testFallback()
  }
  sharedClient ??= new WslTranscriptFsProcessClient(forkWslTranscriptFsProcess)
  return sharedClient.open(path, signal)
}

export function readWslTranscriptFsProcess(
  handle: WslTranscriptFsProcessHandle,
  position: number,
  length: number,
  signal: AbortSignal
): Promise<Buffer> {
  const owner = wslTranscriptFsHandleOwners.get(handle)
  return owner
    ? owner.read(handle, position, length, signal)
    : Promise.reject(
        Object.assign(new Error('WSL transcript file handle is no longer available'), {
          code: 'EBADF'
        })
      )
}

export function closeWslTranscriptFsProcess(handle: WslTranscriptFsProcessHandle): Promise<void> {
  return wslTranscriptFsHandleOwners.get(handle)?.close(handle) ?? Promise.resolve()
}

export function isWslTranscriptFsProcessHandle(
  value: object
): value is WslTranscriptFsProcessHandle {
  return 'wslTranscriptFsProcessHandle' in value
}

export function resetWslTranscriptFsProcessClientForTests(): void {
  sharedClient?.dispose()
  sharedClient = null
}
