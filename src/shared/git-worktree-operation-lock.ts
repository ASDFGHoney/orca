import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

type OperationLane = {
  tail: Promise<void>
  release: () => void
}
const lanes = new Map<string, OperationLane>()

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

async function waitForPredecessor(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    await predecessor.catch(() => undefined)
    return
  }
  if (signal.aborted) {
    throw abortError()
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(abortError())
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([predecessor.catch(() => undefined), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Serialize mutations that leave per-worktree state in progress (for example, rebase). */
export async function runWithGitWorktreeOperationLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const key = await realpath(worktreePath).catch(() => resolve(worktreePath))
  const predecessor = lanes.get(key)?.tail ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  const lane = {
    tail: predecessor.catch(() => undefined).then(() => current),
    release
  }
  lanes.set(key, lane)
  void lane.tail.then(() => {
    if (lanes.get(key) === lane) {
      lanes.delete(key)
    }
  })

  try {
    await waitForPredecessor(predecessor, signal)
    return await run()
  } finally {
    lane.release()
  }
}
