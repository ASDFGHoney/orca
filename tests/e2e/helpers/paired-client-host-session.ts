import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

/**
 * One runtime RPC from a paired client to its host, unwrapped.
 *
 * Why through the client page rather than a RuntimeClient: this is the same transport the client's
 * own UI uses, so a spec that drives the UI and a spec that sets up state through RPC stay on one
 * connection — and a pairing fault shows up in both.
 */
export async function callPairedRuntime<TResult>(
  page: Page,
  selector: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ method, params, selector }) => {
      const response = await window.api.runtimeEnvironments.call({ selector, method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params, selector }
  ) as Promise<TResult>
}

/** Waits until the host's workspace mirror reaches the paired client, and returns its id.
 *  Pass expectedId to pin one specific host workspace; omit it to take whichever arrives. */
export async function waitForPairedClientWorktree(
  page: Page,
  expectedId?: string
): Promise<string> {
  const read = (): Promise<string | null> =>
    page.evaluate(
      (id) =>
        window.__store
          ?.getState()
          .allWorktrees()
          .find((worktree) => !id || worktree.id === id)?.id ?? null,
      expectedId
    )
  await expect.poll(read, { timeout: 30_000 }).not.toBeNull()
  const worktreeId = await read()
  if (!worktreeId) {
    throw new Error('Paired client did not receive the host workspace')
  }
  return worktreeId
}
