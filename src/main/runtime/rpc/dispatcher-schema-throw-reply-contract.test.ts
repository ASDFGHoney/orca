import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, defineStreamingMethod, InvalidArgumentError, type RpcRequest } from './core'
import { ALL_RPC_METHODS } from './methods'
import type { OrcaRuntimeService } from '../orca-runtime'

function makeRuntime(): OrcaRuntimeService {
  return { getRuntimeId: () => 'test-runtime' } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

async function collectStreamingReplies(
  dispatcher: RpcDispatcher,
  request: RpcRequest
): Promise<unknown[]> {
  const replies: string[] = []
  // Why: the production WebSocket call site fires this with `void`, so a rejection here is an
  // unhandled rejection and the caller waits forever. Assert it settles, then count the frames.
  await expect(
    dispatcher.dispatchStreaming(request, (response) => replies.push(response))
  ).resolves.toBeUndefined()
  return replies.map((reply) => JSON.parse(reply) as unknown)
}

// Why: a validator that throws instead of adding an issue — the structural class STA-4818 belongs
// to, kept independent of the computer schemas so the dispatcher guard is covered on its own.
const ThrowingParams = z.object({ key: z.string().optional() }).superRefine((value) => {
  ;(value.key as string).trim()
})

// Why: a second, independent way a param schema throws — zod rejects an async refinement during a
// synchronous safeParse, so this is not specific to a validator forgetting a type check.
const AsyncParams = z.object({ key: z.string() }).refine(async () => true)

const SYNTHETIC_METHODS = [
  defineMethod({
    name: 'orchestration.throwingSchema',
    params: ThrowingParams,
    handler: () => ({ ok: true })
  }),
  defineStreamingMethod({
    name: 'orchestration.throwingStreamingSchema',
    params: ThrowingParams,
    handler: async (_params, _ctx, emit) => {
      emit({ ok: true })
    }
  }),
  defineMethod({
    name: 'orchestration.asyncSchema',
    params: AsyncParams,
    handler: () => ({ ok: true })
  }),
  defineMethod({
    name: 'orchestration.zodThrowingSchema',
    params: z
      .object({})
      .transform(() =>
        z.object({ title: z.string().min(1, 'Title is required') }).parse({ title: '' })
      ),
    handler: () => ({ ok: true })
  }),
  defineMethod({
    name: 'orchestration.invalidArgumentSchema',
    params: z.object({}).transform(() => {
      throw new InvalidArgumentError('Schema rejected the payload')
    }),
    handler: () => ({ ok: true })
  })
]

describe('RpcDispatcher reply contract when a param schema throws', () => {
  for (const method of ['computer.pressKey', 'computer.hotkey'] as const) {
    // The exact payload from STA-4818.
    it(`emits exactly one invalid_argument reply for ${method} with no params (streaming transport)`, async () => {
      const replies = await collectStreamingReplies(
        new RpcDispatcher({ runtime: makeRuntime() }),
        makeRequest(method, {})
      )

      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({
        id: 'req-1',
        ok: false,
        error: {
          code: 'invalid_argument',
          message: expect.stringMatching(/^Missing /)
        }
      })
    })

    it(`returns invalid_argument for ${method} with no params (one-shot transport)`, async () => {
      const dispatcher = new RpcDispatcher({ runtime: makeRuntime() })

      const response = await dispatcher.dispatch(makeRequest(method, {}))

      expect(response).toMatchObject({
        id: 'req-1',
        ok: false,
        error: {
          code: 'invalid_argument',
          message: expect.stringMatching(/^Missing /)
        }
      })
    })

    // Why: a bare dispatcher guard would surface the raw TypeError here instead of naming the
    // flag the caller forgot, so this is what keeps the validators themselves total.
    it(`names the absent key for ${method} when only key is missing`, async () => {
      const dispatcher = new RpcDispatcher({ runtime: makeRuntime() })

      const response = await dispatcher.dispatch(makeRequest(method, { app: 'Finder' }))

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument', message: 'Missing key' }
      })
    })

    it(`keeps reporting the ${method} shape hint for a present but wrong key`, async () => {
      const dispatcher = new RpcDispatcher({ runtime: makeRuntime() })
      const wrongKey = method === 'computer.pressKey' ? 'CmdOrCtrl+V' : 'Return'

      const response = await dispatcher.dispatch(
        makeRequest(method, { app: 'Finder', key: wrongKey })
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message:
            method === 'computer.pressKey'
              ? expect.stringContaining('Press-key accepts one key only')
              : expect.stringContaining('Hotkey requires a modifier and one key')
        }
      })
    })
  }

  it('exercises the computer methods through the real registry', () => {
    const names = new Set(ALL_RPC_METHODS.map((method) => method.name))
    expect(names.has('computer.pressKey')).toBe(true)
    expect(names.has('computer.hotkey')).toBe(true)
  })

  for (const method of [
    'orchestration.throwingSchema',
    'orchestration.throwingStreamingSchema'
  ] as const) {
    it(`emits exactly one invalid_argument reply when ${method}'s schema throws`, async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const replies = await collectStreamingReplies(
          new RpcDispatcher({
            runtime: makeRuntime(),
            methods: SYNTHETIC_METHODS
          }),
          makeRequest(method, {})
        )

        expect(replies).toHaveLength(1)
        expect(replies[0]).toMatchObject({
          id: 'req-1',
          ok: false,
          error: {
            code: 'invalid_argument',
            message: expect.stringContaining(`Invalid params for ${method}`)
          }
        })
        // Why: the guard answers the caller without hiding the programmer error from the host log.
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining(`Param schema for ${method} threw`),
          expect.any(TypeError)
        )
      } finally {
        logged.mockRestore()
      }
    })
  }

  it('returns invalid_argument from the one-shot path when a schema throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dispatcher = new RpcDispatcher({
        runtime: makeRuntime(),
        methods: SYNTHETIC_METHODS
      })

      const response = await dispatcher.dispatch(makeRequest('orchestration.throwingSchema', {}))

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    } finally {
      logged.mockRestore()
    }
  })

  it('emits exactly one invalid_argument reply when a schema needs async parsing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const replies = await collectStreamingReplies(
        new RpcDispatcher({ runtime: makeRuntime(), methods: SYNTHETIC_METHODS }),
        makeRequest('orchestration.asyncSchema', { key: 'ok' })
      )

      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    } finally {
      logged.mockRestore()
    }
  })

  // Why: a schema can throw an error that already carries the right message. Prefixing it with
  // generic guard text would leave the caller worse off than a plain safeParse failure.
  it.each([
    ['orchestration.zodThrowingSchema', 'Title is required'],
    ['orchestration.invalidArgumentSchema', 'Schema rejected the payload']
  ])("reports %s's own validation message verbatim", async (method, message) => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SYNTHETIC_METHODS })

    const response = await dispatcher.dispatch(makeRequest(method, {}))

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument', message } })
  })

  it('still reports unknown methods as method_not_found with exactly one reply', async () => {
    const replies = await collectStreamingReplies(
      new RpcDispatcher({ runtime: makeRuntime(), methods: SYNTHETIC_METHODS }),
      makeRequest('nope.missing', {})
    )

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ error: { code: 'method_not_found' } })
  })

  it('still runs the handler when a throwing-shaped schema accepts the params', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(),
      methods: SYNTHETIC_METHODS
    })

    const response = await dispatcher.dispatch(
      makeRequest('orchestration.throwingSchema', { key: 'ok' })
    )

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })
})
