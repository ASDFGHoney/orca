export function buildOrchestrationRecoveryCommand(
  method: string,
  params: unknown
): string[] | undefined {
  const command =
    method === 'orchestration.workerStart'
      ? 'worker-start'
      : method === 'orchestration.workerStop'
        ? 'worker-stop'
        : method === 'orchestration.workerAbandon'
          ? 'worker-abandon'
          : method === 'orchestration.workerRelease'
            ? 'worker-release'
            : undefined
  if (!command || params === null || typeof params !== 'object') {
    return undefined
  }
  const record = params as Record<string, unknown>
  const requiredKey = command === 'worker-start' ? 'task' : 'dispatch'
  if (typeof record[requiredKey] !== 'string' || record[requiredKey].length === 0) {
    return undefined
  }
  const args = ['orca', 'orchestration', command]
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === false) {
      continue
    }
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    if (value === true) {
      args.push(flag)
    } else if (typeof value === 'string' || typeof value === 'number') {
      args.push(flag, String(value))
    }
  }
  return args
}
