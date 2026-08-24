import type { MobileWebShellSession } from '@orca/expo-mobile-web-shell'

export type MobileWebPackageSession = {
  session: MobileWebShellSession | null
  viewEpoch: number
  packageLoading: boolean
  packageWarning: string | undefined
  markHealthy: (sessionId: string) => Promise<void>
  handleHealthTimeout: (sessionId: string) => Promise<void>
  handleProcessTerminated: (sessionId: string) => Promise<void>
  retryPackage: () => void
  recoverPrevious: () => Promise<void>
  clearCache: () => Promise<void>
  showWarning: (warning: string) => void
}
