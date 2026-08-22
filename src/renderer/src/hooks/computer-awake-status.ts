import { useEffect, useState } from 'react'
import type { ComputerAwakeStatus } from '../../../shared/computer-awake-mode'

const INACTIVE_STATUS: ComputerAwakeStatus = {
  mode: 'off',
  active: false
}

/** Live main-process view of the awake assertion: mode, activity, and macOS engine availability. */
export function useComputerAwakeStatus(): ComputerAwakeStatus {
  const [status, setStatus] = useState<ComputerAwakeStatus>(INACTIVE_STATUS)

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.api.agentAwake.onChanged((next) => {
      if (mounted) {
        setStatus(next)
      }
    })
    void window.api.agentAwake
      .getStatus()
      .then((next) => {
        if (mounted) {
          setStatus(next)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  return status
}
