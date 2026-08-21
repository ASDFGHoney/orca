type CookieDebuggerCommandSession = {
  debugger: {
    sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }
}

const COOKIE_DEBUGGER_COMMAND_TIMEOUT_MS = 10_000
const COOKIE_DEBUGGER_RETIREMENT_TIMEOUT_MS = 1_000

export class CookieDebuggerCommandTimeoutError extends Error {
  constructor(method: string, options?: ErrorOptions) {
    super(
      `Cookie debugger command ${method} timed out after ${COOKIE_DEBUGGER_COMMAND_TIMEOUT_MS}ms`,
      options
    )
    this.name = 'CookieDebuggerCommandTimeoutError'
  }
}

export async function sendCookieDebuggerCommand(
  session: CookieDebuggerCommandSession,
  method: string,
  params: Record<string, unknown> | undefined,
  retire: () => void
): Promise<unknown> {
  let timedOut = false
  let retirementError: unknown = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let retirementTimer: ReturnType<typeof setTimeout> | null = null
  const command = Promise.resolve().then(() => session.debugger.sendCommand(method, params))
  const settled = command.then(
    () => undefined,
    () => undefined
  )
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, COOKIE_DEBUGGER_COMMAND_TIMEOUT_MS)
  })

  try {
    await Promise.race([settled, deadline])
    if (!timedOut) {
      return await command
    }
    let settledDuringGrace = false
    await Promise.race([
      settled.then(() => {
        settledDuringGrace = true
      }),
      new Promise<void>((resolve) => {
        retirementTimer = setTimeout(resolve, COOKIE_DEBUGGER_RETIREMENT_TIMEOUT_MS)
      })
    ])
    if (!settledDuringGrace) {
      try {
        retire()
      } catch (error) {
        retirementError = error
      }
    }
    throw new CookieDebuggerCommandTimeoutError(method, { cause: retirementError })
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
    if (retirementTimer) {
      clearTimeout(retirementTimer)
    }
  }
}
