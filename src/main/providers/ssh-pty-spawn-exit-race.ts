import { isPtyIncarnationId, type PtyIncarnationId } from '../../shared/pty-incarnation'

type QuarantinedSshPtyExit = {
  holders: number
  classified: boolean
  publish: () => void
}

type PendingSshPtySpawn = {
  relayPtyId?: string
  finished?: boolean
  exits: {
    relayPtyId: string
    incarnationId?: PtyIncarnationId
    held?: boolean
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
      // Why: an operation still awaiting its id can bind to this one and fence the exit, so it
      // needs the quarantine to record that verdict — but only a bound match holds the release.
      const tracked =
        publish !== undefined &&
        (operation.relayPtyId === relayPtyId || operation.relayPtyId === undefined)
      const held = tracked && operation.relayPtyId === relayPtyId
      if (held) {
        quarantine.holders++
      }
      operation.exits.push({
        relayPtyId,
        ...(isPtyIncarnationId(incarnationId) ? { incarnationId } : {}),
        ...(tracked ? { held, quarantine } : {})
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
    if (operation.finished) {
      // Why: a second decrement would release the exit while a sibling operation still holds it.
      return
    }
    operation.finished = true
    this.pending.delete(operation)
    for (const exit of operation.exits) {
      const quarantine = exit.quarantine
      if (!quarantine || !exit.held) {
        continue
      }
      quarantine.holders--
      // Why: a failed attach never classifies, and the host's exit is still positive death
      // evidence — release it once no other operation can still claim it, or it is lost forever.
      // A release the reattach could not attribute is still fenced by isCurrentPtyExit (pty.ts).
      if (quarantine.holders === 0 && !quarantine.classified) {
        quarantine.publish()
      }
    }
  }
}
