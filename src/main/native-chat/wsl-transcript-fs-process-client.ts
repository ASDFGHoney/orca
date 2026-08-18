import {
  invalidTranscriptHandleError,
  type WslTranscriptFsProcessCall,
  type WslTranscriptFsProcessResponse,
  type WslTranscriptFsReusableProcessCall
} from './wsl-transcript-fs-process-protocol'
import {
  decodeWslTranscriptFsProcessError,
  decodeWslTranscriptFsProcessValue
} from './wsl-transcript-fs-process-decode'
// Transport faults (spawn failure, child death) mean nothing was consulted —
// surfacing them as plain errors would read as "path missing"/"empty tree" to
// the discovery layers, which only rethrow WslTranscriptFsError.
import { wslTranscriptFsProcessFailureError } from './wsl-transcript-fs-error'
import {
  attachSlotChild,
  WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS,
  WSL_TRANSCRIPT_FS_PROCESS_IDLE_REAP_MS,
  type HandleState,
  type ProcessSlot,
  type SlotDisposition,
  type WslTranscriptFsProcessFactory,
  type WslTranscriptFsProcessHandle
} from './wsl-transcript-fs-process-slot'

export type { WslTranscriptFsProcessHandle } from './wsl-transcript-fs-process-slot'

/** Routes cross-module handle calls back to the owning client. */
export const wslTranscriptFsHandleOwners = new WeakMap<
  WslTranscriptFsProcessHandle,
  WslTranscriptFsProcessClient
>()

export class WslTranscriptFsProcessClient {
  private readonly idle: ProcessSlot[] = []
  private readonly slots = new Set<ProcessSlot>()
  private readonly handles = new WeakMap<WslTranscriptFsProcessHandle, HandleState>()
  /** Handles retired by a slot fault/kill, not by a clean close: reads on them
   *  are a transport condition, never a caller bug. */
  private readonly faultedHandles = new WeakSet<WslTranscriptFsProcessHandle>()
  private nextId = 1

  constructor(private readonly processFactory: WslTranscriptFsProcessFactory) {}

  async run<T>(request: WslTranscriptFsReusableProcessCall, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    return this.send<T>(this.takeSlotOrThrow(), request, signal, 'idle')
  }

  async open(path: string, signal: AbortSignal): Promise<WslTranscriptFsProcessHandle> {
    signal.throwIfAborted()
    const slot = this.takeSlotOrThrow()
    const handleId = await this.send<number>(slot, { operation: 'open', path }, signal, 'pin')
    if (!this.slots.has(slot)) {
      throw wslTranscriptFsProcessFailureError('the process exited while opening a file')
    }
    const handle = Object.freeze({
      wslTranscriptFsProcessHandle: true as const
    })
    slot.handle = handle
    this.handles.set(handle, { slot, handleId })
    wslTranscriptFsHandleOwners.set(handle, this)
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
      return Promise.reject(
        this.faultedHandles.has(handle)
          ? wslTranscriptFsProcessFailureError('the process owning this file handle exited')
          : invalidTranscriptHandleError()
      )
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
    if (!state.closePromise) {
      state.closePromise = this.performClose(handle, state)
      // The stored promise may reject before any caller chains onto it.
      void state.closePromise.catch(() => {})
    }
    return state.closePromise
  }

  // Why: a close can arrive while the handle's read is still in flight (the
  // gate waiter gave up but the child is mid-syscall). Refusing would strand
  // the pinned slot forever once that read settles — pinned slots have no idle
  // reap — so defer under the close deadline instead, and retire the slot if
  // even the wait times out.
  private async performClose(
    handle: WslTranscriptFsProcessHandle,
    state: HandleState
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error('WSL transcript file handle close timed out'))
      if (this.slots.has(state.slot) && state.slot.active) {
        this.rejectActive(
          state.slot,
          wslTranscriptFsProcessFailureError('the process was retired by a stuck close')
        )
        this.destroySlot(state.slot)
      }
    }, WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS)
    timer.unref?.()
    try {
      while (state.slot.active) {
        const settled = state.slot.activeSettled
        if (!settled) {
          break
        }
        await settled
        if (controller.signal.aborted) {
          throw controller.signal.reason
        }
        if (this.handles.get(handle) !== state) {
          // The slot died while waiting; the fd died with the child.
          return
        }
      }
      if (this.handles.get(handle) !== state) {
        return
      }
      await this.send<boolean>(
        state.slot,
        { operation: 'close', handleId: state.handleId },
        controller.signal,
        'close'
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private send<T>(
    slot: ProcessSlot,
    request: WslTranscriptFsProcessCall,
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
      slot.activeSettled = new Promise((resolveSettled) => {
        slot.notifyActiveSettled = resolveSettled
      })
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
        slot.child.send({ ...request, id }, (error) => {
          if (error && slot.active?.id === id) {
            this.rejectActive(slot, wslTranscriptFsProcessFailureError(error))
            this.destroySlot(slot)
          }
        })
      } catch (error) {
        this.rejectActive(slot, wslTranscriptFsProcessFailureError(error))
        this.destroySlot(slot)
      }
    })
  }

  dispose(): void {
    for (const slot of this.slots) {
      this.rejectActive(slot, wslTranscriptFsProcessFailureError('the client was disposed'))
      this.destroySlot(slot)
    }
  }

  private takeSlotOrThrow(): ProcessSlot {
    try {
      const slot = this.idle.pop()
      if (!slot) {
        return this.createSlot()
      }
      clearTimeout(slot.idleTimer)
      return slot
    } catch (error) {
      throw wslTranscriptFsProcessFailureError(error)
    }
  }

  private parkIdle(slot: ProcessSlot): void {
    this.idle.push(slot)
    slot.idleTimer = setTimeout(
      () => this.destroySlot(slot),
      WSL_TRANSCRIPT_FS_PROCESS_IDLE_REAP_MS
    )
    slot.idleTimer.unref?.()
  }

  private createSlot(): ProcessSlot {
    const child = this.processFactory()
    const slot = attachSlotChild(child, {
      onResponse: (response) => this.onResponse(slot, response),
      onFault: (error) => this.onFault(slot, error)
    })
    this.slots.add(slot)
    return slot
  }

  private onResponse(slot: ProcessSlot, response: WslTranscriptFsProcessResponse): void {
    const call = slot.active
    if (!call || call.id !== response.id) {
      return
    }
    this.clearActive(slot)
    call.signal.removeEventListener('abort', call.onAbort)
    if (!response.ok) {
      call.reject(decodeWslTranscriptFsProcessError(response.error))
    } else {
      try {
        call.resolve(decodeWslTranscriptFsProcessValue(call.operation, response.value))
      } catch (error) {
        // An undecodable ok-response means the protocol is corrupt: fail the
        // call and retire the slot rather than leave the promise unsettled.
        call.reject(error)
        this.destroySlot(slot)
        return
      }
    }
    switch (call.disposition) {
      case 'idle':
        this.parkIdle(slot)
        break
      case 'pin':
        if (!response.ok) {
          this.parkIdle(slot)
        }
        break
      case 'pinned':
        break
      case 'close':
        if (!response.ok) {
          this.destroySlot(slot)
        } else {
          this.releaseHandle(slot)
          this.parkIdle(slot)
        }
        break
    }
  }

  private onFault(slot: ProcessSlot, error: Error): void {
    if (!this.slots.has(slot)) {
      return
    }
    this.rejectActive(slot, wslTranscriptFsProcessFailureError(error))
    this.destroySlot(slot)
  }

  private clearActive(slot: ProcessSlot): void {
    slot.active = null
    slot.notifyActiveSettled?.()
    slot.notifyActiveSettled = undefined
    slot.activeSettled = undefined
  }

  private rejectActive(slot: ProcessSlot, error: unknown): void {
    const call = slot.active
    this.clearActive(slot)
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
    clearTimeout(slot.idleTimer)
    const idleIndex = this.idle.indexOf(slot)
    if (idleIndex !== -1) {
      this.idle.splice(idleIndex, 1)
    }
    if (slot.handle) {
      this.faultedHandles.add(slot.handle)
    }
    this.releaseHandle(slot)
    slot.child.removeAllListeners()
    try {
      slot.child.kill('SIGKILL')
    } catch {
      // Teardown race: kill of an already-terminating child emits 'error' with
      // no listeners left, which throws synchronously; the child dies anyway.
    }
  }

  private releaseHandle(slot: ProcessSlot): void {
    const handle = slot.handle
    slot.handle = null
    if (!handle) {
      return
    }
    this.handles.delete(handle)
    // The owners entry stays (WeakMap, collected with the handle) so late
    // cross-module reads still reach this client for a classified rejection.
  }
}
