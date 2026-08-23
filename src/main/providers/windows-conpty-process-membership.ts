/**
 * Bundled ConPTY runs its console in OpenConsole, so a sibling helper cannot
 * attach and prove exact membership. Fail closed without forking.
 */
export function readWindowsConptyProcessIds(_rootPid: number): Promise<ReadonlySet<number> | null> {
  return Promise.resolve(null)
}
