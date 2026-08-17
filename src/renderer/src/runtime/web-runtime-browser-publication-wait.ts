const HOST_GENERATED_BROWSER_PUBLICATION_RETRY_DELAYS_MS = [40, 120, 360, 1_080] as const

export async function waitForHostGeneratedBrowserPublication(args: {
  isMaterialized: () => boolean
  refresh: () => Promise<void>
  canRetry: () => boolean
}): Promise<boolean> {
  if (args.isMaterialized()) {
    return true
  }
  for (const delayMs of HOST_GENERATED_BROWSER_PUBLICATION_RETRY_DELAYS_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    if (!args.canRetry()) {
      return false
    }
    if (args.isMaterialized()) {
      return true
    }
    await args.refresh()
    if (args.isMaterialized()) {
      return true
    }
  }
  return false
}
