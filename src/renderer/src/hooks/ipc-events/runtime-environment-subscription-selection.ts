import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'

export function buildRuntimeClientEventEnvironmentKey(environmentIds: string[]): string {
  return [...new Set(environmentIds)]
    .sort()
    .map(
      (environmentId) =>
        `${environmentId}:${getRuntimeEnvironmentConnectionGeneration(environmentId)}:${getEnvironmentSshStateGeneration(environmentId)}:${getRuntimeEnvironmentRevision(environmentId) ?? 'unknown'}`
    )
    .join('\u0000')
}

/** Ids in `next` not in `previous` — environments that just became connected. */
export function getNewlyConnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  const known = new Set(previous)
  return [...new Set(next)].filter((environmentId) => !known.has(environmentId))
}

/** Ids in `previous` not in `next` — environments whose transport was just observed down. */
export function getNewlyDisconnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  return getNewlyConnectedRuntimeEnvironmentIds(next, previous)
}

export function getRuntimeProjectRefreshEnvironmentIds(args: {
  previousDesired: readonly string[]
  nextDesired: readonly string[]
  previousReachable: readonly string[]
  nextReachable: readonly string[]
}): string[] {
  return [
    ...new Set([
      ...getNewlyConnectedRuntimeEnvironmentIds(args.previousDesired, args.nextDesired),
      ...getNewlyConnectedRuntimeEnvironmentIds(args.previousReachable, args.nextReachable)
    ])
  ]
}
