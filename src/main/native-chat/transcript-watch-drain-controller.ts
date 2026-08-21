export function createTranscriptWatchDrainController(args: {
  isClosed: () => boolean
  drainOnce: () => Promise<void>
  onError: (error: unknown) => void
}) {
  let reading = false
  let pendingReadRequested = false

  return {
    requestAnotherPass(): void {
      pendingReadRequested = true
    },
    async drain(): Promise<void> {
      if (args.isClosed()) {
        return
      }
      if (reading) {
        pendingReadRequested = true
        return
      }
      reading = true
      try {
        do {
          pendingReadRequested = false
          try {
            await args.drainOnce()
          } catch (error) {
            args.onError(error)
            break
          }
        } while (pendingReadRequested && !args.isClosed())
      } finally {
        reading = false
      }
    }
  }
}
