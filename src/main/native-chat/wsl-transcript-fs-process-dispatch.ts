import { open, type FileHandle } from 'node:fs/promises'
import type {
  WslTranscriptFsProcessRequest,
  WslTranscriptFsReusableProcessCall
} from './wsl-transcript-fs-process-protocol'
import { decodeWslTranscriptFsProcessValue } from './wsl-transcript-fs-process-decode'
import {
  wslTranscriptFsHandleOwners,
  WslTranscriptFsProcessClient,
  type WslTranscriptFsProcessHandle
} from './wsl-transcript-fs-process-client'
import { WslTranscriptFsProcessOperations } from './wsl-transcript-fs-process-operations'
import { forkWslTranscriptFsProcess } from './wsl-transcript-fs-process-spawn'

export type { WslTranscriptFsProcessHandle } from './wsl-transcript-fs-process-client'

// Why: an env-only check would let a leaked VITEST=true (harnesses spreading
// process.env into a real app) silently revert production to in-process UNC
// syscalls; the worker global only exists inside an actual vitest runtime.
function inVitestWorker(): boolean {
  return process.env.VITEST === 'true' && '__vitest_worker__' in globalThis
}

// Unit suites run the child's own dispatcher (decode included) in-process, so
// there is exactly one request implementation to drift; production never
// bypasses the process boundary.
let inProcessOperations: WslTranscriptFsProcessOperations | null = null

function runInProcess<T>(request: WslTranscriptFsReusableProcessCall): Promise<T> {
  inProcessOperations ??= new WslTranscriptFsProcessOperations()
  return inProcessOperations
    .execute({ ...request, id: 0 } as WslTranscriptFsProcessRequest)
    .then((value) => decodeWslTranscriptFsProcessValue(request.operation, value)) as Promise<T>
}

let sharedClient: WslTranscriptFsProcessClient | null = null

export function runWslTranscriptFsProcess<T>(
  request: WslTranscriptFsReusableProcessCall,
  signal: AbortSignal
): Promise<T> {
  if (inVitestWorker()) {
    return runInProcess<T>(request)
  }
  sharedClient ??= new WslTranscriptFsProcessClient(forkWslTranscriptFsProcess)
  return sharedClient.run<T>(request, signal)
}

export function openWslTranscriptFsProcess(
  path: string,
  signal: AbortSignal
): Promise<WslTranscriptFsProcessHandle | FileHandle> {
  if (inVitestWorker()) {
    // A real FileHandle: suites drive reads and closes through the plain
    // handle branch, mirroring non-UNC ownership.
    return open(path, 'r')
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
