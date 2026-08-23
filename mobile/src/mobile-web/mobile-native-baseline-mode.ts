const NATIVE_BASELINE_FLAG = '1'

export function mobileNativeBaselineMode(args: {
  developmentBuild: boolean
  requested: string | undefined
}): boolean {
  return args.developmentBuild && args.requested === NATIVE_BASELINE_FLAG
}

export const MOBILE_NATIVE_BASELINE_MODE = mobileNativeBaselineMode({
  developmentBuild: typeof __DEV__ !== 'undefined' && __DEV__,
  requested: process.env.EXPO_PUBLIC_ORCA_E2E_MOBILE_NATIVE_BASELINE
})
