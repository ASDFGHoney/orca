import { fork, type ChildProcess } from 'node:child_process'

const CONPTY_PROCESS_LIST_TIMEOUT_MS = 3_000
const CONPTY_PROCESS_LIST_QUEUE_LIMIT = 1

type ProcessListMessage = { consoleProcessList?: unknown }

type WindowsConptyMembershipReaderDeps = {
  forkProcess?: typeof fork
  resolveAgentPath?: () => string
  timeoutMs?: number
}

type MembershipRequest = {
  deadlineAt: number
  owner: object | number
  promise: Promise<ReadonlySet<number> | null>
  resolve: (value: ReadonlySet<number> | null) => void
  rootPid: number
  settled: boolean
  timeout: NodeJS.Timeout
}

type ActiveProbe = {
  child: ChildProcess
  onClose: () => void
  onError: () => void
  onMessage: (message: ProcessListMessage) => void
  request: MembershipRequest
  stopping: boolean
}

function resolveNodePtyConsoleListAgent(): string {
  return require.resolve('node-pty/lib/conpty_console_list_agent.js')
}

function normalizeProcessIds(
  value: unknown,
  requiredPids: readonly number[]
): ReadonlySet<number> | null {
  if (
    !Array.isArray(value) ||
    requiredPids.some((pid) => !value.includes(pid)) ||
    value.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  ) {
    return null
  }
  return new Set(value)
}

/** Owns the single console-list subprocess admitted by one PTY host process. */
export class WindowsConptyProcessMembershipReader {
  private readonly deps: Required<WindowsConptyMembershipReaderDeps>
  private readonly requestsByOwner = new Map<object | number, MembershipRequest>()
  private readonly queue: MembershipRequest[] = []
  private active: ActiveProbe | null = null
  private disposed = false

  constructor(deps: WindowsConptyMembershipReaderDeps = {}) {
    this.deps = {
      forkProcess: deps.forkProcess ?? fork,
      resolveAgentPath: deps.resolveAgentPath ?? resolveNodePtyConsoleListAgent,
      timeoutMs: deps.timeoutMs ?? CONPTY_PROCESS_LIST_TIMEOUT_MS
    }
  }

  read(rootPid: number, owner: object | number = rootPid): Promise<ReadonlySet<number> | null> {
    if (this.disposed || !Number.isSafeInteger(rootPid) || rootPid <= 0) {
      return Promise.resolve(null)
    }
    const existing = this.requestsByOwner.get(owner)
    if (existing) {
      return existing.promise
    }
    if (this.active && this.queue.length >= CONPTY_PROCESS_LIST_QUEUE_LIMIT) {
      return Promise.resolve(null)
    }
    let resolveRequest!: (value: ReadonlySet<number> | null) => void
    const promise = new Promise<ReadonlySet<number> | null>((resolve) => {
      resolveRequest = resolve
    })
    let request: MembershipRequest
    const deadlineAt = Math.min(
      Date.now() + this.deps.timeoutMs,
      this.active?.request.deadlineAt ?? Number.POSITIVE_INFINITY
    )
    const timeout = setTimeout(() => this.expire(request), deadlineAt - Date.now())
    request = {
      deadlineAt,
      owner,
      promise,
      resolve: resolveRequest,
      rootPid,
      settled: false,
      timeout
    }
    this.requestsByOwner.set(owner, request)
    this.queue.push(request)
    this.pump()
    return promise
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const request of this.queue) {
      this.finish(request, null)
    }
    this.queue.length = 0
    if (this.active) {
      this.finish(this.active.request, null)
      this.stopActive(this.active)
    }
  }

  private expire(request: MembershipRequest): void {
    if (request.settled) {
      return
    }
    this.finish(request, null)
    if (this.active?.request === request) {
      this.stopActive(this.active)
      return
    }
    const queueIndex = this.queue.indexOf(request)
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1)
    }
  }

  private pump(): void {
    if (this.disposed || this.active) {
      return
    }
    let request = this.queue.shift()
    while (request && (request.settled || Date.now() >= request.deadlineAt)) {
      this.finish(request, null)
      request = this.queue.shift()
    }
    if (!request) {
      return
    }

    let child: ChildProcess
    try {
      child = this.deps.forkProcess(this.deps.resolveAgentPath(), [String(request.rootPid)], {
        silent: true
      })
    } catch {
      this.finish(request, null)
      this.pump()
      return
    }

    let probe: ActiveProbe
    const onError = (): void => {
      this.finish(request, null)
      this.stopActive(probe)
    }
    const onClose = (): void => this.release(probe)
    const onMessage = (message: ProcessListMessage): void => {
      const helperPid = child.pid
      const processIds = normalizeProcessIds(message?.consoleProcessList, [
        request.rootPid,
        ...(helperPid === undefined ? [] : [helperPid])
      ])
      if (helperPid === undefined || processIds === null) {
        this.finish(request, null)
      } else {
        const consoleProcessIds = new Set(processIds)
        consoleProcessIds.delete(helperPid)
        this.finish(request, consoleProcessIds)
      }
      // The upstream agent is one-shot; close follows process end and owns replacement admission.
      this.stopActive(probe)
    }
    probe = { child, onClose, onError, onMessage, request, stopping: false }
    this.active = probe
    child.once('message', probe.onMessage)
    child.on('error', probe.onError)
    child.once('close', probe.onClose)
  }

  private finish(request: MembershipRequest, value: ReadonlySet<number> | null): void {
    if (request.settled) {
      return
    }
    request.settled = true
    clearTimeout(request.timeout)
    if (this.requestsByOwner.get(request.owner) === request) {
      this.requestsByOwner.delete(request.owner)
    }
    request.resolve(value)
  }

  private stopActive(probe: ActiveProbe): void {
    if (probe.stopping) {
      return
    }
    probe.stopping = true
    try {
      probe.child.kill()
    } catch {
      // A failed reap holds the only slot, preserving the subprocess bound.
    }
  }

  private release(probe: ActiveProbe): void {
    probe.child.removeListener('message', probe.onMessage)
    probe.child.removeListener('error', probe.onError)
    probe.child.removeListener('close', probe.onClose)
    this.finish(probe.request, null)
    if (this.active === probe) {
      this.active = null
      this.pump()
    }
  }
}

const defaultReader = new WindowsConptyProcessMembershipReader()
// The host process owns this supervisor and reaps its child during orderly exit.
process.once('exit', () => defaultReader.dispose())

type WindowsConptyProcessReadOptions = {
  owner?: object
  reader?: Pick<WindowsConptyProcessMembershipReader, 'read'>
}

/** Returns proved PTY membership, or null when the owning host cannot prove it. */
export function readWindowsConptyProcessIds(
  rootPid: number,
  options: WindowsConptyProcessReadOptions = {}
): Promise<ReadonlySet<number> | null> {
  return (options.reader ?? defaultReader).read(rootPid, options.owner ?? rootPid)
}
