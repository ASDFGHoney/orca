import type { ChildProcess } from 'node:child_process'
import type {
  WslTranscriptFsProcessRequest,
  WslTranscriptFsProcessResponse
} from './wsl-transcript-fs-process-protocol'
import {
  decodeWslTranscriptFsProcessError,
  decodeWslTranscriptFsProcessValue
} from './wsl-transcript-fs-process-decode'
import { forkWslTranscriptFsProcess } from './wsl-transcript-fs-process-spawn'

type ProcessRequest = WslTranscriptFsProcessRequest extends infer Request
  ? Request extends WslTranscriptFsProcessRequest
    ? Omit<Request, 'id'>
    : never
  : never
type ReusableProcessRequest = Exclude<ProcessRequest, { operation: 'open' | 'read' | 'close' }>
type SlotDisposition = 'idle' | 'pin' | 'pinned' | 'close'
type ActiveCall = {
  id: number
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  signal: AbortSignal
  onAbort: () => void
  operation: WslTranscriptFsProcessRequest['operation']
  disposition: SlotDisposition
}
export type WslTranscriptFsProcessHandle = {
  readonly wslTranscriptFsProcessHandle: true
}
type ProcessSlot = {
  child: ChildProcess
  active: ActiveCall | null
  handle: WslTranscriptFsProcessHandle | null
}
type HandleState = {
  slot: ProcessSlot
  handleId: number
  closePromise?: Promise<void>
}
export type WslTranscriptFsProcessFactory = () => ChildProcess
export const WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS = 30_000

const handleOwners = new WeakMap<WslTranscriptFsProcessHandle, WslTranscriptFsProcessClient>()

export class WslTranscriptFsProcessClient {
  private readonly idle: ProcessSlot[] = []
  private readonly slots = new Set<ProcessSlot>()
  private readonly handles = new WeakMap<WslTranscriptFsProcessHandle, HandleState>()
  private nextId = 1

  constructor(private readonly processFactory: WslTranscriptFsProcessFactory) {}

  run<T>(request: ReusableProcessRequest, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let slot: ProcessSlot
    try {
      slot = this.idle.pop() ?? this.createSlot()
    } catch (error) {
      return Promise.reject(error)
    }
    return this.send<T>(slot, request, signal, 'idle')
  }

  async open(path: string, signal: AbortSignal): Promise<WslTranscriptFsProcessHandle> {
    signal.throwIfAborted()
    const slot = this.idle.pop() ?? this.createSlot()
    const handleId = await this.send<number>(slot, { operation: 'open', path }, signal, 'pin')
    if (!this.slots.has(slot)) {
      throw new Error('WSL filesystem process exited while opening a file')
    }
    const handle = Object.freeze({
      wslTranscriptFsProcessHandle: true as const
    })
    slot.handle = handle
    this.handles.set(handle, { slot, handleId })
    handleOwners.set(handle, this)
    return handle
  }

  read(
    handle: WslTranscriptFsProcessHandle,
    position: number,
    length: number,
    signal: AbortSignal
  ): Promise<Buffer> {
    signal.throwIfAborted()
    const state = this.handles.get(handle)
    if (!state) {
      return Promise.reject(this.invalidHandleError())
    }
    if (state.slot.active) {
      return Promise.reject(new Error('WSL transcript file handle is already in use'))
    }
    return this.send<Buffer>(
      state.slot,
      { operation: 'read', handleId: state.handleId, position, length },
      signal,
      'pinned'
    )
  }

  close(handle: WslTranscriptFsProcessHandle): Promise<void> {
    const state = this.handles.get(handle)
    if (!state) {
      return Promise.resolve()
    }
    if (state.closePromise) {
      return state.closePromise
    }
    if (state.slot.active) {
      return Promise.reject(new Error('WSL transcript file handle is already in use'))
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('WSL transcript file handle close timed out')),
      WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS
    )
    timer.unref?.()
    state.closePromise = this.send<boolean>(
      state.slot,
      { operation: 'close', handleId: state.handleId },
      controller.signal,
      'close'
    ).then(() => undefined)
    void state.closePromise.finally(() => clearTimeout(timer)).catch(() => {})
    return state.closePromise
  }

  private send<T>(
    slot: ProcessSlot,
    request: ProcessRequest,
    signal: AbortSignal,
    disposition: SlotDisposition
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const onAbort = (): void => {
        if (slot.active?.id !== id) {
          return
        }
        this.rejectActive(slot, signal.reason ?? new Error('WSL filesystem process aborted'))
        this.destroySlot(slot)
      }
      slot.active = {
        id,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
        onAbort,
        operation: request.operation,
        disposition
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        slot.child.send({ ...request, id } as WslTranscriptFsProcessRequest, (error) => {
          if (error && slot.active?.id === id) {
            this.rejectActive(slot, error)
            this.destroySlot(slot)
          }
        })
      } catch (error) {
        this.rejectActive(slot, error)
        this.destroySlot(slot)
      }
    })
  }

  dispose(): void {
    for (const slot of this.slots) {
      this.rejectActive(slot, new Error('WSL filesystem process client disposed'))
      this.destroySlot(slot)
    }
  }

  private createSlot(): ProcessSlot {
    const child = this.processFactory()
    const slot: ProcessSlot = { child, active: null, handle: null }
    this.slots.add(slot)
    child.on('message', (response: WslTranscriptFsProcessResponse) =>
      this.onResponse(slot, response)
    )
    child.on('error', (error) => this.onFault(slot, error))
    child.on('disconnect', () =>
      this.onFault(slot, new Error('WSL filesystem process disconnected'))
    )
    child.on('exit', (code) =>
      this.onFault(slot, new Error(`WSL filesystem process exited (${code})`))
    )
    child.unref()
    child.channel?.unref?.()
    return slot
  }

  private onResponse(slot: ProcessSlot, response: WslTranscriptFsProcessResponse): void {
    const call = slot.active
    if (!call || call.id !== response.id) {
      return
    }
    slot.active = null
    call.signal.removeEventListener('abort', call.onAbort)
    if (!response.ok) {
      call.reject(decodeWslTranscriptFsProcessError(response.error))
    } else {
      call.resolve(decodeWslTranscriptFsProcessValue(call.operation, response.value))
    }
    if (!response.ok && call.disposition === 'close') {
      this.destroySlot(slot)
    } else if (call.disposition === 'idle' || call.disposition === 'close') {
      if (call.disposition === 'close') {
        this.releaseHandle(slot)
      }
      this.idle.push(slot)
    } else if (!response.ok && call.disposition === 'pin') {
      this.idle.push(slot)
    }
  }

  private onFault(slot: ProcessSlot, error: Error): void {
    if (!this.slots.has(slot)) {
      return
    }
    this.rejectActive(slot, error)
    this.destroySlot(slot)
  }

  private rejectActive(slot: ProcessSlot, error: unknown): void {
    const call = slot.active
    slot.active = null
    if (!call) {
      return
    }
    call.signal.removeEventListener('abort', call.onAbort)
    call.reject(error)
  }

  private destroySlot(slot: ProcessSlot): void {
    if (!this.slots.delete(slot)) {
      return
    }
    const idleIndex = this.idle.indexOf(slot)
    if (idleIndex !== -1) {
      this.idle.splice(idleIndex, 1)
    }
    this.releaseHandle(slot)
    slot.child.removeAllListeners()
    slot.child.kill('SIGKILL')
  }

  private releaseHandle(slot: ProcessSlot): void {
    const handle = slot.handle
    slot.handle = null
    if (!handle) {
      return
    }
    this.handles.delete(handle)
    handleOwners.delete(handle)
  }

  private invalidHandleError(): NodeJS.ErrnoException {
    return Object.assign(new Error('WSL transcript file handle is no longer available'), {
      code: 'EBADF'
    })
  }
}

let sharedClient: WslTranscriptFsProcessClient | null = null

export function runWslTranscriptFsProcess<T>(
  request: ReusableProcessRequest,
  signal: AbortSignal,
  testFallback?: () => Promise<T>
): Promise<T> {
  // Unit suites inject filesystem stalls directly; production never bypasses the process boundary.
  if (process.env.VITEST === 'true' && testFallback) {
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
  if (process.env.VITEST === 'true' && testFallback) {
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
  const owner = handleOwners.get(handle)
  return owner
    ? owner.read(handle, position, length, signal)
    : Promise.reject(
        Object.assign(new Error('WSL transcript file handle is no longer available'), {
          code: 'EBADF'
        })
      )
}

export function closeWslTranscriptFsProcess(handle: WslTranscriptFsProcessHandle): Promise<void> {
  return handleOwners.get(handle)?.close(handle) ?? Promise.resolve()
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
