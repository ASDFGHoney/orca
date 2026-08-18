// STA-3714 / STA-4513: `worker-show` is the per-lane call a coordinator makes, and it
// reported a worker parked on a human prompt exactly the same as one mid tool call.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const WORKER_HANDLE = 'term_worker'
const WORKER_PANE_KEY = 'tab_worker:leaf_worker'
const WORKER_INCARNATION = 'runtime_test:term_worker:1'

function workerShowMethod() {
  const method = ORCHESTRATION_METHODS.find(
    (candidate) => candidate.name === 'orchestration.workerShow'
  )
  if (!method) {
    throw new Error('Missing method orchestration.workerShow')
  }
  return method
}

describe('worker-show interactive wait (STA-3714, STA-4513)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  async function showInjectedWorker(
    agentWait: ReturnType<OrcaRuntimeService['getTerminalInteractiveWait']>
  ) {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: WORKER_HANDLE,
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(WORKER_PANE_KEY)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(WORKER_INCARNATION)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: [WORKER_INCARNATION]
    })
    const interactiveWait = vi
      .spyOn(runtime, 'getTerminalInteractiveWait')
      .mockReturnValue(agentWait)

    const run = db.createRun({
      objective: 'supervise lanes',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'run the suite', runId: run.id })
    const dispatch = db.createDispatchContext(
      task.id,
      WORKER_HANDLE,
      WORKER_PANE_KEY,
      'launch-hash',
      WORKER_INCARNATION
    )
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: WORKER_INCARNATION
    })
    const method = workerShowMethod()
    const result = await method.handler(method.params?.parse({ dispatch: dispatch.id }), {
      runtime
    })
    return { result, interactiveWait }
  }

  it('names the pending prompt on the observation a coordinator polls', async () => {
    const { result, interactiveWait } = await showInjectedWorker({
      source: 'prompt-text',
      reason: 'agent-approval-prompt',
      since: 1_700_000_000_000
    })

    expect(result).toMatchObject({
      observation: {
        status: 'live',
        exactWorker: true,
        agentWait: {
          source: 'prompt-text',
          reason: 'agent-approval-prompt',
          since: 1_700_000_000_000
        }
      }
    })
    expect(interactiveWait).toHaveBeenCalledWith(WORKER_HANDLE)
  })

  it('reports an explicit null for a lane that is merely working', async () => {
    // Why an explicit null and not an omitted key: a coordinator has to tell "not waiting"
    // from "this host is too old to know", and only absence may mean the latter.
    const { result } = await showInjectedWorker(null)

    expect(result).toMatchObject({ observation: { status: 'live', agentWait: null } })
  })
})
