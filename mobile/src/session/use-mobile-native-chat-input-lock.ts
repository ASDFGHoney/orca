import { useEffect, useState } from 'react'

const INPUT_LOCK_SETTLE_MS = 600

/** Why the composer input is locked: the transport is disconnected, or the
 *  terminal subscription has not acknowledged its input lease yet. */
export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

/** A dead PTY emits subscribed→end; settle both edges so its false lease cannot
 *  flash the composer enabled. */
export function useSettledInputLockReason(
  raw: MobileNativeChatInputLockReason | null
): MobileNativeChatInputLockReason | null {
  const rawHeld = raw !== null
  const [lockHeld, setLockHeld] = useState(false)
  useEffect(() => {
    if (rawHeld === lockHeld) {
      return
    }
    const timer = setTimeout(() => setLockHeld(rawHeld), INPUT_LOCK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [lockHeld, rawHeld])
  return lockHeld ? (raw ?? 'waiting') : null
}
