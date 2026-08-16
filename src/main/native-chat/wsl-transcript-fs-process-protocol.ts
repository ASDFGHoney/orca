export type WslTranscriptFsProcessRequest =
  | { id: number; operation: 'access'; path: string }
  | { id: number; operation: 'stat' | 'lstat' | 'readdir' | 'open'; path: string }
  | { id: number; operation: 'readfile'; path: string; encoding: BufferEncoding }
  | { id: number; operation: 'read'; handleId: number; position: number; length: number }
  | { id: number; operation: 'close'; handleId: number }

export type WslTranscriptFsDirent = {
  name: string
  parentPath: string
  isBlockDevice: boolean
  isCharacterDevice: boolean
  isDirectory: boolean
  isFIFO: boolean
  isFile: boolean
  isSocket: boolean
  isSymbolicLink: boolean
}

export type WslTranscriptFsProcessError = {
  name: string
  message: string
  code?: string
  errno?: number
  syscall?: string
  path?: string
}

export type WslTranscriptFsProcessResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WslTranscriptFsProcessError }
