import { useState, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  recoveryActionLabel,
  type AutomationHostRecoveryAction
} from './automation-host-status-descriptors'

export function AutomationHostRecoverButton({
  action,
  onRecover,
  size = 'xs',
  className
}: {
  action: AutomationHostRecoveryAction
  onRecover: (action: AutomationHostRecoveryAction) => void | Promise<void>
  size?: 'xs' | 'sm'
  className?: string
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={className}
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        const result = onRecover(action)
        if (result instanceof Promise) {
          setBusy(true)
          void result.finally(() => setBusy(false))
        }
      }}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
      {recoveryActionLabel(action)}
    </Button>
  )
}
