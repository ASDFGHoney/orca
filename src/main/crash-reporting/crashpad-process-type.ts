// Electron's process-gone `processType` vocabulary is not Crashpad's dump
// annotation vocabulary; map once so both the report and the suppression path
// fence dumps by the same name.
const CHILD_CRASHPAD_PROCESS_TYPES: Readonly<Record<string, string>> = {
  gpu: 'gpu-process',
  utility: 'utility',
  zygote: 'zygote'
}

export function crashpadProcessTypeFor(source: string, processType: string): string | null {
  return source === 'renderer'
    ? 'renderer'
    : (CHILD_CRASHPAD_PROCESS_TYPES[processType.trim().toLowerCase()] ?? null)
}
