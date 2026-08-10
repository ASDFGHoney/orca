import type { ClaudeInitObservation } from './claude-structured-init-proof'

export type ClaudeInitDeadline = {
  promise: Promise<ClaudeInitObservation>
  resolve: (init: ClaudeInitObservation) => void
  reject: (error: Error) => void
  start: () => void
  clear: () => void
}

export function createClaudeInitDeadline(sessionId: string, timeoutMs: number): ClaudeInitDeadline {
  let resolve = (_init: ClaudeInitObservation): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<ClaudeInitObservation>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  void promise.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    promise,
    resolve,
    reject,
    start: () => {
      timer = setTimeout(
        () => reject(new Error(`claude session ${sessionId} did not emit system/init`)),
        timeoutMs
      )
      timer.unref?.()
    },
    clear: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
