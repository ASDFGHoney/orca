import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { grantDirAcl, isPermissionError } from '../win32-utils'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import { isBrowserRoutePartition } from './browser-route-identity'

const BINDING_STORE_VERSION = 2
const LEGACY_BINDING_STORE_VERSION = 1
const DEFAULT_MAX_BINDINGS = 512
const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const FINGERPRINT_RE = /^[a-f0-9]{64}$/
const PERSIST_PARTITION_PREFIX = 'persist:'

/**
 * Persisted binding for one route partition.
 *
 * `storageScope` names the environment record that owns the partition so
 * explicit lifecycle events (environment removal) and orphan collection can
 * find it without re-deriving an identity that needs a live connection.
 * `null` marks a pre-scope entry from the per-boot partition scheme, whose
 * partition name can no longer be derived and is therefore always an orphan.
 */
export type BrowserRoutePartitionBinding = {
  fingerprint: string
  storageScope: string | null
}

type BindingState = {
  bindings: Record<string, BrowserRoutePartitionBinding>
}

export class BrowserRoutePartitionBindingStore {
  private readonly maxBindings: number
  private readonly maxFileBytes: number

  constructor(
    private readonly options: {
      filePath: string
      partitionDataRoot?: string
      maxBindings?: number
      maxFileBytes?: number
    }
  ) {
    this.maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  }

  get(partition: string): string | null {
    assertBinding(partition, 'a'.repeat(64))
    const state = this.load()
    this.assertMetadataPrecedesPartitionData(partition, state)
    return state.bindings[partition]?.fingerprint ?? null
  }

  listBindings(): ReadonlyMap<string, BrowserRoutePartitionBinding> {
    return new Map(Object.entries(this.load().bindings))
  }

  /** Drops binding metadata for partitions whose Chromium storage was destroyed. */
  remove(partitions: readonly string[]): number {
    const state = this.load()
    const remaining = { ...state.bindings }
    let removed = 0
    for (const partition of partitions) {
      if (remaining[partition] !== undefined) {
        delete remaining[partition]
        removed += 1
      }
    }
    if (removed === 0) {
      return 0
    }
    this.persist({ bindings: remaining })
    return removed
  }

  set(partition: string, fingerprint: string, storageScope: string): void {
    assertBinding(partition, fingerprint)
    assertStorageScope(storageScope)
    const state = this.load()
    this.assertMetadataPrecedesPartitionData(partition, state)
    const existing = state.bindings[partition]
    if (existing?.fingerprint === fingerprint && existing.storageScope === storageScope) {
      return
    }
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      throw new Error('browser_route_partition_binding_conflict')
    }
    if (existing === undefined && Object.keys(state.bindings).length >= this.maxBindings) {
      throw new Error('browser_route_partition_binding_capacity')
    }
    this.persist({
      bindings: { ...state.bindings, [partition]: { fingerprint, storageScope } }
    })
  }

  private persist(state: BindingState): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true })
    this.writeDurably(
      `${JSON.stringify({ version: BINDING_STORE_VERSION, bindings: state.bindings })}\n`
    )
  }

  private load(): BindingState {
    if (!existsSync(this.options.filePath)) {
      return { bindings: {} }
    }
    try {
      const parsed: unknown = JSON.parse(
        readBoundedUtf8File(this.options.filePath, this.maxFileBytes)
      )
      const bindings = parseBindings(parsed, this.maxBindings)
      if (!bindings) {
        throw new Error('invalid binding state')
      }
      return { bindings }
    } catch {
      throw new Error('browser_route_partition_binding_store_invalid')
    }
  }

  private assertMetadataPrecedesPartitionData(partition: string, state: BindingState): void {
    if (state.bindings[partition] !== undefined || !this.options.partitionDataRoot) {
      return
    }
    const partitionPath = join(
      this.options.partitionDataRoot,
      partition.slice(PERSIST_PARTITION_PREFIX.length)
    )
    try {
      statSync(partitionPath)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return
      }
      throw new Error('browser_route_partition_binding_store_invalid')
    }
    throw new Error('browser_route_partition_binding_store_invalid')
  }

  private writeDurably(contents: string): void {
    try {
      writeFileDurableSync(
        durableWriteTempPath(this.options.filePath),
        this.options.filePath,
        contents
      )
    } catch (error) {
      if (!isPermissionError(error) || process.platform !== 'win32') {
        throw error
      }
      grantDirAcl(dirname(this.options.filePath))
      writeFileDurableSync(
        durableWriteTempPath(this.options.filePath),
        this.options.filePath,
        contents
      )
    }
  }
}

function readBoundedUtf8File(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error('binding file size invalid')
    }
    const contents = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = readSync(fd, contents, offset, size - offset, null)
      if (bytesRead === 0) {
        throw new Error('binding file truncated')
      }
      offset += bytesRead
    }
    const overflowProbe = Buffer.alloc(1)
    if (readSync(fd, overflowProbe, 0, 1, null) !== 0) {
      throw new Error('binding file grew during read')
    }
    return contents.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function parseBindings(
  value: unknown,
  maxBindings: number
): Record<string, BrowserRoutePartitionBinding> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const candidate = value as { version?: unknown; bindings?: unknown }
  const version = candidate.version
  if (
    (version !== BINDING_STORE_VERSION && version !== LEGACY_BINDING_STORE_VERSION) ||
    !candidate.bindings ||
    typeof candidate.bindings !== 'object' ||
    Array.isArray(candidate.bindings)
  ) {
    return null
  }
  const entries = Object.entries(candidate.bindings as Record<string, unknown>)
  if (entries.length > maxBindings) {
    return null
  }
  const bindings: Record<string, BrowserRoutePartitionBinding> = {}
  for (const [partition, entry] of entries) {
    const binding = parseBinding(version === LEGACY_BINDING_STORE_VERSION, entry)
    if (!binding) {
      return null
    }
    try {
      assertBinding(partition, binding.fingerprint)
    } catch {
      return null
    }
    bindings[partition] = binding
  }
  return bindings
}

function parseBinding(legacy: boolean, entry: unknown): BrowserRoutePartitionBinding | null {
  if (legacy) {
    return typeof entry === 'string' ? { fingerprint: entry, storageScope: null } : null
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }
  const candidate = entry as { fingerprint?: unknown; storageScope?: unknown }
  if (typeof candidate.fingerprint !== 'string') {
    return null
  }
  if (candidate.storageScope === null) {
    return { fingerprint: candidate.fingerprint, storageScope: null }
  }
  if (typeof candidate.storageScope !== 'string' || !FINGERPRINT_RE.test(candidate.storageScope)) {
    return null
  }
  return { fingerprint: candidate.fingerprint, storageScope: candidate.storageScope }
}

function assertBinding(partition: string, fingerprint: string): void {
  if (!isBrowserRoutePartition(partition) || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error('browser_route_partition_binding_invalid')
  }
}

function assertStorageScope(storageScope: string): void {
  if (!FINGERPRINT_RE.test(storageScope)) {
    throw new Error('browser_route_partition_binding_invalid')
  }
}
