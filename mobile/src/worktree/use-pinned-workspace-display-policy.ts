import { useEffect, useRef, useState } from 'react'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  getPinnedWorktreeDisplayPolicy,
  type PinnedWorktreeDisplayPolicy
} from '../../../src/shared/worktree/pinned-display-policy'

// Fetches the desktop's GlobalSettings.showPinnedWorktreesInGroups so the mobile list duplicates
// pinned workspaces into their natural groups only when the user opted in on desktop (#15494).
// There is no settings-change stream over the mobile RPC, so this is a per-connection snapshot.
export function usePinnedWorkspaceDisplayPolicy(
  client: RpcClient | null,
  connState: ConnectionState
): PinnedWorktreeDisplayPolicy {
  const [policy, setPolicy] = useState<PinnedWorktreeDisplayPolicy>('single-location')
  const sourceClientRef = useRef<RpcClient | null>(null)

  useEffect(() => {
    if (!client || connState !== 'connected') {
      sourceClientRef.current = null
      setPolicy('single-location')
      return
    }
    if (sourceClientRef.current !== client) {
      // Why: the setting belongs to the connected runtime; never render a prior host's
      // policy while the replacement host is still loading.
      sourceClientRef.current = client
      setPolicy('single-location')
    }
    let stale = false
    void client
      .sendRequest('settings.get')
      .then((response) => {
        if (stale || !response.ok) {
          return
        }
        const result = (response as RpcSuccess).result as {
          settings?: { showPinnedWorktreesInGroups?: boolean }
        } | null
        setPolicy(getPinnedWorktreeDisplayPolicy(result?.settings))
      })
      .catch(() => {
        // Best-effort: single-location is desktop's default, and older hosts omit the field.
      })
    return () => {
      stale = true
    }
  }, [client, connState])

  return policy
}
