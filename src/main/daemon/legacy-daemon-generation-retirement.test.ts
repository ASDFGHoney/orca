import { describe, expect, it, vi } from 'vitest'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'
import {
  retireIdleLegacyDaemonGenerations,
  type LegacyGenerationRetirementAdapter
} from './legacy-daemon-generation-retirement'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

function createAdapter(options: {
  protocolVersion?: number
  sessions?: {
    id: string
    agentSessionOwners?: unknown[]
    inspection?: PtyProcessInspection | Error
  }[]
  listError?: Error
}): LegacyGenerationRetirementAdapter & {
  disconnectOnly: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
} {
  const disconnectOnly = vi.fn(async () => {})
  const shutdown = vi.fn(async () => {})
  return {
    protocolVersion: options.protocolVersion ?? CLEAN_DISCONNECT_PROTOCOL_VERSION,
    listProcesses: vi.fn(async () => {
      if (options.listError) {
        throw options.listError
      }
      return (options.sessions ?? []).map((session) => ({
        id: session.id,
        ...(session.agentSessionOwners ? { agentSessionOwners: session.agentSessionOwners } : {})
      }))
    }),
    inspectProcess: vi.fn(async (id: string) => {
      const session = options.sessions?.find((candidate) => candidate.id === id)
      if (session?.inspection instanceof Error) {
        throw session.inspection
      }
      if (session?.inspection) {
        return session.inspection
      }
      return { foregroundProcess: 'zsh', hasChildProcesses: false }
    }),
    disconnectOnly,
    shutdown
  }
}

const matchingIdentity = vi.fn(async () => 'match' as const)
const otherInstallIdentity = vi.fn(async () => 'mismatch' as const)
const unknownIdentity = vi.fn(async () => 'unknown' as const)

describe('retireIdleLegacyDaemonGenerations', () => {
  it('retires an old-generation daemon whose sessions are all provably idle', async () => {
    const idle = createAdapter({ sessions: [] })

    const result = await retireIdleLegacyDaemonGenerations({
      adapters: [idle],
      runtimeDir: '/tmp/orca-daemon',
      currentEntryPath: '/Applications/Orca.app/Contents/out/main/daemon-entry.js',
      getDaemonLaunchIdentity: matchingIdentity
    })

    expect(idle.disconnectOnly).toHaveBeenCalledOnce()
    expect(idle.shutdown).not.toHaveBeenCalled()
    expect(result.kept).toEqual([])
    expect(result.retiredProtocolVersions).toEqual([CLEAN_DISCONNECT_PROTOCOL_VERSION])
    expect(result.leaks).toEqual([])
  })

  it('does not retire an old-generation daemon hosting a session with recent activity', async () => {
    const live = createAdapter({
      sessions: [
        {
          id: 'pty-agent',
          agentSessionOwners: [{ provider: 'claude' }],
          inspection: { foregroundProcess: 'zsh', hasChildProcesses: false }
        }
      ]
    })

    const result = await retireIdleLegacyDaemonGenerations({
      adapters: [live],
      runtimeDir: '/tmp/orca-daemon',
      currentEntryPath: '/Applications/Orca.app/Contents/out/main/daemon-entry.js',
      getDaemonLaunchIdentity: matchingIdentity
    })

    expect(live.disconnectOnly).not.toHaveBeenCalled()
    expect(live.shutdown).not.toHaveBeenCalled()
    expect(result.kept).toEqual([live])
    expect(result.retiredProtocolVersions).toEqual([])
    expect(result.leaks).toEqual([])
  })

  it('does not retire an unverifiable session and reports the leak', async () => {
    const unverifiable = createAdapter({
      listError: new Error('inventory timed out')
    })

    const result = await retireIdleLegacyDaemonGenerations({
      adapters: [unverifiable],
      runtimeDir: '/tmp/orca-daemon',
      currentEntryPath: '/Applications/Orca.app/Contents/out/main/daemon-entry.js',
      getDaemonLaunchIdentity: matchingIdentity
    })

    expect(unverifiable.disconnectOnly).not.toHaveBeenCalled()
    expect(result.kept).toEqual([unverifiable])
    expect(result.retiredProtocolVersions).toEqual([])
    expect(result.leaks).toEqual([
      {
        protocolVersion: CLEAN_DISCONNECT_PROTOCOL_VERSION,
        reason: 'inventory timed out'
      }
    ])
  })

  it('does not retire when process inspection is unavailable', async () => {
    const unverifiable = createAdapter({
      sessions: [
        {
          id: 'pty-gap',
          inspection: { foregroundProcess: null, hasChildProcesses: true, unavailable: true }
        }
      ]
    })

    const result = await retireIdleLegacyDaemonGenerations({
      adapters: [unverifiable],
      runtimeDir: '/tmp/orca-daemon',
      currentEntryPath: '/Applications/Orca.app/Contents/out/main/daemon-entry.js',
      getDaemonLaunchIdentity: matchingIdentity
    })

    expect(unverifiable.disconnectOnly).not.toHaveBeenCalled()
    expect(result.kept).toEqual([unverifiable])
    expect(result.leaks).toEqual([
      {
        protocolVersion: CLEAN_DISCONNECT_PROTOCOL_VERSION,
        reason: 'liveness unverifiable for pty-gap'
      }
    ])
  })

  it('does not touch a daemon from a different install', async () => {
    const foreign = createAdapter({ sessions: [] })

    const result = await retireIdleLegacyDaemonGenerations({
      adapters: [foreign],
      runtimeDir: '/tmp/orca-daemon',
      currentEntryPath: '/Applications/Orca.app/Contents/out/main/daemon-entry.js',
      getDaemonLaunchIdentity: otherInstallIdentity
    })

    expect(foreign.disconnectOnly).not.toHaveBeenCalled()
    expect(result.kept).toEqual([foreign])
    expect(result.retiredProtocolVersions).toEqual([])
  })

  it('does not retire when install identity cannot be established', async () => {
    const unknown = createAdapter({ sessions: [] })

    const result = await retireIdleLegacyDaemonGenerations({
      adapters: [unknown],
      runtimeDir: '/tmp/orca-daemon',
      currentEntryPath: '/Applications/Orca.app/Contents/out/main/daemon-entry.js',
      getDaemonLaunchIdentity: unknownIdentity
    })

    expect(unknown.disconnectOnly).not.toHaveBeenCalled()
    expect(result.kept).toEqual([unknown])
  })

  it('does not kill idle sessions still hosted on the generation', async () => {
    const idleShell = createAdapter({
      sessions: [
        {
          id: 'pty-idle',
          inspection: { foregroundProcess: 'zsh', hasChildProcesses: false }
        }
      ]
    })

    const result = await retireIdleLegacyDaemonGenerations({
      adapters: [idleShell],
      runtimeDir: '/tmp/orca-daemon',
      currentEntryPath: '/Applications/Orca.app/Contents/out/main/daemon-entry.js',
      getDaemonLaunchIdentity: matchingIdentity
    })

    expect(idleShell.shutdown).not.toHaveBeenCalled()
    expect(idleShell.disconnectOnly).not.toHaveBeenCalled()
    expect(result.kept).toEqual([idleShell])
    expect(result.retiredProtocolVersions).toEqual([])
  })
})
