/**
 * Everything a rejected git exec wrote, as one string.
 *
 * Why both fields: `execFile` folds git's stderr into `message`, but relay and
 * buffer-capped runners can surface the fatal line only on a separate `stderr`.
 */
export function readGitExecErrorText(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  const record = error as { message?: unknown; stderr?: unknown }
  return [record.message, record.stderr].filter((part) => typeof part === 'string').join('\n')
}
