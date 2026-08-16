import { Stats, type Dirent } from 'node:fs'
import type {
  WslTranscriptFsDirent,
  WslTranscriptFsProcessError,
  WslTranscriptFsProcessRequest
} from './wsl-transcript-fs-process-protocol'

export function decodeWslTranscriptFsProcessError(value: WslTranscriptFsProcessError): Error {
  const error = new Error(value.message) as NodeJS.ErrnoException
  error.name = value.name
  Object.assign(error, value)
  return error
}

function decodeDirent(value: WslTranscriptFsDirent): Dirent {
  return {
    name: value.name,
    parentPath: value.parentPath,
    isBlockDevice: () => value.isBlockDevice,
    isCharacterDevice: () => value.isCharacterDevice,
    isDirectory: () => value.isDirectory,
    isFIFO: () => value.isFIFO,
    isFile: () => value.isFile,
    isSocket: () => value.isSocket,
    isSymbolicLink: () => value.isSymbolicLink
  } as Dirent
}

/** Revive prototype-dependent results the structured clone stripped. */
export function decodeWslTranscriptFsProcessValue(
  operation: WslTranscriptFsProcessRequest['operation'],
  value: unknown
): unknown {
  if (operation === 'stat' || operation === 'lstat') {
    return Object.setPrototypeOf(value as object, Stats.prototype)
  }
  if (operation === 'readdir') {
    return (value as WslTranscriptFsDirent[]).map(decodeDirent)
  }
  return value
}
