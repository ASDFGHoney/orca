import React from 'react'
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  CircleDashed,
  CircleMinus,
  GitPullRequest
} from 'lucide-react'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'

export const PullRequestIcon = GitPullRequest

export const CHECK_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  success: CircleCheck,
  failure: CircleX,
  pending: LoaderCircle,
  cancelled: CircleMinus,
  skipped: CircleMinus,
  neutral: CircleDashed,
  timed_out: CircleX,
  action_required: CircleDashed,
  stale: CircleDashed
}

export const CHECK_COLOR: Record<string, string> = {
  success: 'text-emerald-500',
  failure: 'text-rose-500',
  pending: 'text-amber-500',
  cancelled: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
  neutral: 'text-muted-foreground',
  timed_out: 'text-rose-500',
  action_required: 'text-amber-500',
  stale: 'text-muted-foreground'
}

export function prStateColor(state: PRInfo['state']): string {
  switch (state) {
    case 'merged':
      return 'bg-purple-500/15 text-purple-500 border-purple-500/20'
    case 'closed':
      return 'bg-rose-500/15 text-rose-500 border-rose-500/20'
    case 'draft':
      return 'bg-muted text-muted-foreground border-border'
    case 'open':
      return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20'
  }
}
