// Forked so a killed WSL UNC syscall cannot retain a libuv thread in Orca.
import type {
  WslTranscriptFsProcessError,
  WslTranscriptFsProcessRequest,
  WslTranscriptFsProcessResponse
} from './wsl-transcript-fs-process-protocol'
import { WslTranscriptFsProcessOperations } from './wsl-transcript-fs-process-operations'

const operations = new WslTranscriptFsProcessOperations()

function serializeError(error: unknown): WslTranscriptFsProcessError {
  const value = error as NodeJS.ErrnoException | null
  return {
    name: value?.name ?? 'Error',
    message: value?.message ?? String(error),
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
    ...(typeof value?.errno === 'number' ? { errno: value.errno } : {}),
    ...(typeof value?.syscall === 'string' ? { syscall: value.syscall } : {}),
    ...(typeof value?.path === 'string' ? { path: value.path } : {})
  }
}

process.on('message', (request: WslTranscriptFsProcessRequest) => {
  void operations.execute(request).then(
    (value) =>
      process.send?.({ id: request.id, ok: true, value } satisfies WslTranscriptFsProcessResponse),
    (error: unknown) =>
      process.send?.({
        id: request.id,
        ok: false,
        error: serializeError(error)
      } satisfies WslTranscriptFsProcessResponse)
  )
})

process.on('disconnect', () => process.exit(0))
