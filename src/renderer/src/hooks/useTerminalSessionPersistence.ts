import { useEffect, useState } from 'react'

/**
 * Whether the daemon that carries terminal sessions across a quit is serving this app.
 * `null` = not answered yet or the probe failed; the caller must claim nothing either way.
 */
export function useTerminalSessionPersistence(enabled: boolean): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const result = await window.api.pty.management.sessionPersistence()
        if (!cancelled && typeof result.available === 'boolean') {
          setAvailable(result.available)
        }
      } catch {
        // Why: an unanswered probe stays unknown rather than inventing either verdict.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  return available
}
