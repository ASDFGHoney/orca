import { isPtyIncarnationId, type PtyIncarnationId } from '../../shared/pty-incarnation'

type QuarantinedSshPtyExit = {
  holders: number
  classified: boolean
  publish: () => void
}

type PendingSshPtySpawn = {
  relayPtyId?: string
  exits: {
    relayPtyId: string
    incarnationId?: PtyIncarnationId
    quarantine?: QuarantinedSshPtyExit
  }[]
}

type SshPtyPendingExitOutcome = 'exited' | 'unverifiable' | null

export class SshPtySpawnExitRaceTracker {
  private pending = new Set<PendingSshPtySpawn>()

  begin(relayPtyId?: string): PendingSshPtySpawn {
    const operation = { ...(relayPtyId ? { relayPtyId } : {}), exits: [] }
    this.pending.add(operation)
    return operation
  }

  bind(operation: PendingSshPtySpawn, relayPtyId: string): void {
    operation.relayPtyId = relayPtyId
  }

  recordExit(relayPtyId: string, incarnationId: unknown, publish?: () => void): boolean {
    let published = false
    const quarantine: QuarantinedSshPtyExit = {
      holders: 0,
      classified: false,
      publish: () => {
        if (!published) {
          published = true
          publish?.()
        }
      }
    }
    for (const operation of this.pending) {
      const held = operation.relayPtyId === relayPtyId && publish !== undefined
      if (held) {
        quarantine.holders++
      }
      operation.exits.push({
        relayPtyId,
        ...(isPtyIncarnationId(incarnationId) ? { incarnationId } : {}),
        ...(held ? { quarantine } : {})
      })
    }
    return quarantine.holders > 0
  }

  classifyPendingExit(
    operation: PendingSshPtySpawn,
    result: { id: string; incarnationId?: PtyIncarnationId }
  ): SshPtyPendingExitOutcome {
    const sameIdExits = operation.exits.filter((exit) => exit.relayPtyId === result.id)
    for (const exit of sameIdExits) {
      // Why: a reached verdict owns the exit, so finish() must not second-guess it and re-publish.
      if (exit.quarantine) {
        exit.quarantine.classified = true
      }
    }
    if (!result.incarnationId) {
      return sameIdExits.length > 0 ? 'unverifiable' : null
    }
    const matchingExit = sameIdExits.find((exit) => exit.incarnationId === result.incarnationId)
    if (matchingExit) {
      matchingExit.quarantine?.publish()
      return 'exited'
    }
    return sameIdExits.some((exit) => !exit.incarnationId) ? 'unverifiable' : null
  }

  finish(operation: PendingSshPtySpawn): void {
    this.pending.delete(operation)
    for (const exit of operation.exits) {
      const quarantine = exit.quarantine
      if (!quarantine) {
        continue
      }
      quarantine.holders--
      // Why: a failed attach never classifies, and the host's exit is still positive death
      // evidence — release it once no other operation can still claim it, or it is lost forever.
      if (quarantine.holders === 0 && !quarantine.classified) {
        quarantine.publish()
      }
    }
  }
}
