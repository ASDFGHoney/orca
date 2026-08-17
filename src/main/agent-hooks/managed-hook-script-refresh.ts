import { randomUUID } from 'node:crypto'
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { grantDirAclAsync, isPermissionError } from '../win32-utils'

type ExistingScript = { exists: false } | { exists: true; content: string | null }

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readExistingScript(scriptPath: string): Promise<ExistingScript> {
  try {
    return { exists: true, content: await readFile(scriptPath, 'utf-8') }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { exists: false }
    }
    try {
      await stat(scriptPath)
      return { exists: true, content: null }
    } catch (statError) {
      if (isMissingPathError(statError)) {
        return { exists: false }
      }
      throw error
    }
  }
}

async function scriptStillExists(scriptPath: string): Promise<boolean> {
  try {
    await stat(scriptPath)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
}

async function writeScriptWithAclRetry(scriptPath: string, content: string): Promise<void> {
  try {
    await writeFile(scriptPath, content, 'utf-8')
  } catch (error) {
    if (isPermissionError(error) && process.platform === 'win32') {
      try {
        await grantDirAclAsync(dirname(scriptPath))
        await writeFile(scriptPath, content, 'utf-8')
        return
      } catch {
        // Re-throw the original permission error.
      }
    }
    throw error
  }
}

// Why: refresh must not block Electron's main thread or create state for an absent CLI.
export async function refreshManagedScriptIfPresent(
  scriptPath: string,
  content: string
): Promise<boolean> {
  const existing = await readExistingScript(scriptPath)
  if (!existing.exists) {
    return false
  }
  if (existing.content === content) {
    if (process.platform !== 'win32') {
      await chmod(scriptPath, 0o755)
    }
    return true
  }

  const tmpPath = join(dirname(scriptPath), `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    await writeScriptWithAclRetry(tmpPath, content)
    if (process.platform !== 'win32') {
      await chmod(tmpPath, 0o755)
    }
    if (!(await scriptStillExists(scriptPath))) {
      return false
    }
    try {
      await rename(tmpPath, scriptPath)
    } catch (error) {
      // Why (#14221): on Windows any open read handle on the target — AV scanner, backup
      // agent, search indexer, editor — fails the atomic replace with EPERM. The caller
      // only logs, so the script stays frozen at whatever an older Orca generated and the
      // agent keeps invoking it. An in-place write still succeeds against that handle, so
      // prefer a non-atomic refresh over stranding a stale script indefinitely.
      if (!isPermissionError(error) || process.platform !== 'win32') {
        throw error
      }
      // Why: the fallback write creates what it opens, so re-check rather than resurrect a
      // script removed since the check above — that would reinstate a hook the user just
      // disabled. Still a narrow race, but the alternative is a guaranteed stale script.
      if (!(await scriptStillExists(scriptPath))) {
        return false
      }
      await writeScriptWithAclRetry(scriptPath, content)
    }
    return true
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}
