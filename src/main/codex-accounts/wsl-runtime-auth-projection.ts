import { readFileSync } from 'node:fs'
import { codexAuthMatchesSystemDefaultIdentity } from './codex-auth-identity'
import {
  classifyStoredCodexAuthContents,
  readStoredCodexCredentialState
} from './managed-codex-auth-readiness'

export type WslRuntimeAuthProjection =
  | { action: 'replace' }
  | { action: 'keep'; deselect: boolean }
  | { action: 'wipe' }

export function decideWslRuntimeAuthProjection(args: {
  runtimeAuthPath: string
  sourceAuthContents: string | null
  explicitAccountSwitch: boolean
}): WslRuntimeAuthProjection {
  const runtimeState = readStoredCodexCredentialState(args.runtimeAuthPath)
  if (runtimeState === 'unreadable' || runtimeState === 'incomplete') {
    return { action: 'keep', deselect: false }
  }
  if (args.explicitAccountSwitch) {
    return args.sourceAuthContents ? { action: 'replace' } : { action: 'wipe' }
  }
  if (runtimeState === 'missing' || runtimeState === 'no-credential') {
    return args.sourceAuthContents ? { action: 'replace' } : { action: 'wipe' }
  }

  const runtimeContents = readRuntimeAuthContents(args.runtimeAuthPath)
  if (runtimeContents === null) {
    return { action: 'keep', deselect: false }
  }
  if (!args.sourceAuthContents) {
    return { action: 'keep', deselect: true }
  }
  if (wslRuntimeAuthMayReplaceSource(runtimeContents, args.sourceAuthContents)) {
    return { action: 'replace' }
  }
  return { action: 'keep', deselect: true }
}

// Why: a live API-key (or other mismatched) runtime login is not dirt to restore.
export function wslRuntimeAuthMayReplaceSource(
  runtimeContents: string,
  sourceContents: string
): boolean {
  const runtime = classifyStoredCodexAuthContents(runtimeContents)
  const source = classifyStoredCodexAuthContents(sourceContents)
  if (runtime.state !== 'present' || source.state !== 'present' || runtime.mode !== source.mode) {
    return false
  }
  return (
    runtime.mode !== 'chatgpt' ||
    codexAuthMatchesSystemDefaultIdentity(runtimeContents, sourceContents)
  )
}

function readRuntimeAuthContents(runtimeAuthPath: string): string | null {
  try {
    return readFileSync(runtimeAuthPath, 'utf-8')
  } catch {
    // Why: a race off the earlier present-state read is still not absence; skip.
    return null
  }
}
