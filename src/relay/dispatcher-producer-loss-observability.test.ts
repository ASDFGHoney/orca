import { describe, expect, it, vi, afterEach } from 'vitest'
import { RelayDispatcher } from './dispatcher'

// Why these bounds: a 20KB frame exceeds the 16KB producer frame capacity, so each notify
// is dropped over-capacity rather than queued — the storm shape this summary exists for.
function makeSaturatedDispatcher(): { dispatcher: RelayDispatcher; stderr: string[] } {
  const stderr: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  const dispatcher = new RelayDispatcher(() => true, {
    writableHighWaterMark: () => 16384,
    writableLength: () => 0,
    close: () => {}
  })
  return { dispatcher, stderr }
}

const flood = { events: ['x'.repeat(20_000)] }

describe('relay producer loss observability', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('summarises a sustained drop storm instead of logging only the first frame', () => {
    vi.useFakeTimers()
    const { dispatcher, stderr } = makeSaturatedDispatcher()

    for (let i = 0; i < 5; i += 1) {
      dispatcher.notify('fs.changed', flood)
    }
    const beforeSummary = stderr.filter((line) => line.includes('Producer loss')).length

    // Why advance past the interval: summaries are emitted from the drop path, so a later
    // drop is what publishes the window — no timer fires on its own.
    vi.advanceTimersByTime(11_000)
    dispatcher.notify('fs.changed', flood)

    const summaries = stderr.filter((line) => line.includes('Producer loss'))
    expect(beforeSummary).toBe(0)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatch(/\d+ dropped \(\d+B\)/)
    dispatcher.dispose()
  })

  it('counts admission vetoes, which are otherwise filtered out with no trace', () => {
    vi.useFakeTimers()
    const { dispatcher, stderr } = makeSaturatedDispatcher()

    // Veto every pty.data publication: pre-fix this filtered silently.
    dispatcher.registerPtyDataPublicationAdmission(() => false)
    for (let i = 0; i < 3; i += 1) {
      dispatcher.notify('pty.data', { id: 'pty-1', data: 'x' })
    }

    vi.advanceTimersByTime(11_000)
    dispatcher.notify('pty.data', { id: 'pty-1', data: 'x' })

    const summaries = stderr.filter((line) => line.includes('Producer loss'))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatch(/[1-9]\d* vetoed by admission/)
    dispatcher.dispose()
  })
})
