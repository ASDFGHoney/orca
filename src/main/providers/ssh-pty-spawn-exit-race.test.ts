import { expect, it, vi } from 'vitest'
import { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'

it('keeps a late-bound operation the owner of the exit it fenced', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const bound = tracker.begin('pty-1')
  const late = tracker.begin()

  tracker.recordExit('pty-1', 'incarnation-old', publish)
  tracker.bind(late, 'pty-1')
  expect(tracker.classifyPendingExit(late, { id: 'pty-1', incarnationId: 'incarnation-new' })).toBe(
    null
  )
  tracker.finish(late)
  tracker.finish(bound)

  expect(publish).not.toHaveBeenCalled()
})

it('does not release a quarantined exit when one operation finishes twice', () => {
  const tracker = new SshPtySpawnExitRaceTracker()
  const publish = vi.fn()
  const first = tracker.begin('pty-1')
  tracker.begin('pty-1')

  tracker.recordExit('pty-1', 'incarnation-old', publish)
  tracker.finish(first)
  tracker.finish(first)

  expect(publish).not.toHaveBeenCalled()
})
