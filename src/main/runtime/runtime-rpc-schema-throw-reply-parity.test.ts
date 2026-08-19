import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import type { OrcaRuntimeService } from './orca-runtime'

// STA-4818: a param schema that throws must still produce exactly one structured
// reply on every transport, not a silent hang plus an unhandled rejection.
const THROWING_PARAM_METHODS = ['computer.pressKey', 'computer.hotkey'] as const

function makeServer(): { server: OrcaRuntimeRpcServer; deviceToken: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rpc-schema-throw-'))
  const runtime = { getRuntimeId: () => 'test-runtime' } as OrcaRuntimeService
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: false
  })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  // Why: computer.* is off the mobile allowlist; runtime-scope pairings reach it.
  const device = server['deviceRegistry']!.addDevice('desktop', 'runtime')
  return { server, deviceToken: device.token }
}

describe('RPC reply contract when a param schema throws', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }

  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })

  for (const method of THROWING_PARAM_METHODS) {
    it(`replies once with invalid_argument over WebSocket for ${method} with a missing key`, async () => {
      const { server, deviceToken } = makeServer()
      const replies: string[] = []

      // Why: mirrors the production call site, which fires this off with `void`.
      await server['handleWebSocketMessage'](
        JSON.stringify({ id: 'ws-1', method, deviceToken, params: {} }),
        (response) => replies.push(response),
        () => {}
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(replies).toHaveLength(1)
      expect(JSON.parse(replies[0])).toMatchObject({
        id: 'ws-1',
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(unhandled).toEqual([])
    })

    it(`matches the unix-socket reply for ${method} with a missing key`, async () => {
      const { server, deviceToken } = makeServer()
      const wsReplies: string[] = []
      await server['handleWebSocketMessage'](
        JSON.stringify({ id: 'req-1', method, deviceToken, params: {} }),
        (response) => wsReplies.push(response),
        () => {}
      )

      const socketResponse = await server['handleMessage'](
        JSON.stringify({
          id: 'req-1',
          method,
          authToken: server['authToken'],
          params: {}
        })
      )

      expect(socketResponse).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(socketResponse).toEqual(JSON.parse(wsReplies[0]))
    })
  }
})
