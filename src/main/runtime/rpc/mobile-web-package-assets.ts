import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  MOBILE_WEB_PACKAGE_MAX_IN_FLIGHT_BYTES,
  MobileWebPackageAssetChunkSchema,
  MobileWebPackageGzipAssetChunkSchema,
  MobileWebPackageManifestResponseSchema,
  type MobileWebPackageAssetChunk,
  type MobileWebPackageGzipAssetChunk,
  type MobileWebPackageAssetParams,
  type MobileWebPackageManifestResponse
} from '../../../shared/mobile-web/package-rpc-contract'
import {
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  MobileWebManifestSchema,
  serializeMobileWebManifestForBuildId,
  type MobileWebAsset,
  type MobileWebManifest
} from '../../../shared/mobile-web/manifest-contract'
import { resolveMobileWebPackageRoot } from './mobile-web-package-root'

type VerifiedMobileWebPackage = {
  root: string
  manifestFingerprint: string
  manifest: MobileWebManifest
  assetsByPath: ReadonlyMap<string, MobileWebAsset>
  fileStatsByPath: ReadonlyMap<string, { size: number; mtimeMs: number }>
}

type PackageReadState = { count: number; bytes: number }
type AssetRangeReader = (path: string, offset: number, length: number) => Promise<Buffer>

type MobileWebPackageAssetsOptions = {
  resolveRoot?: () => string
  readAssetRange?: AssetRangeReader
}

export class MobileWebPackageAssets {
  private readonly resolveRoot: () => string
  private readonly readAssetRange: AssetRangeReader
  private cached: { fingerprint: string; package: VerifiedMobileWebPackage } | null = null
  private verifying: {
    root: string
    fingerprint: string
    promise: Promise<VerifiedMobileWebPackage>
  } | null = null
  private readonly readStates = new Map<string, PackageReadState>()
  private readonly gzipChunks = new Map<string, Buffer>()

  constructor(options: MobileWebPackageAssetsOptions = {}) {
    this.resolveRoot = options.resolveRoot ?? resolveMobileWebPackageRoot
    this.readAssetRange = options.readAssetRange ?? readAssetRange
  }

  async getManifest(): Promise<MobileWebPackageManifestResponse> {
    const verified = await this.getVerifiedPackage()
    return MobileWebPackageManifestResponseSchema.parse({
      manifest: verified.manifest,
      chunkBytes: MOBILE_WEB_PACKAGE_CHUNK_BYTES
    })
  }

  async getAssetChunk(
    params: MobileWebPackageAssetParams,
    options: { connectionId?: string; signal?: AbortSignal } = {}
  ): Promise<MobileWebPackageAssetChunk> {
    throwIfAborted(options.signal)
    const verified = await this.getVerifiedPackage()
    const asset = this.validateAssetParams(verified, params)
    const byteLength = Math.min(MOBILE_WEB_PACKAGE_CHUNK_BYTES, asset.byteLength - params.offset)
    const release = this.acquireRead(options.connectionId ?? 'in-process', byteLength)
    try {
      const path = resolveDeclaredAssetPath(verified.root, asset.path)
      const expectedStat = verified.fileStatsByPath.get(asset.path)!
      const currentStat = await stat(path)
      if (currentStat.size !== expectedStat.size || currentStat.mtimeMs !== expectedStat.mtimeMs) {
        this.cached = null
        throw new Error('mobile_web_package_asset_changed')
      }
      const bytes = await this.readAssetRange(path, params.offset, byteLength)
      throwIfAborted(options.signal)
      if (bytes.byteLength !== byteLength) {
        throw new Error('mobile_web_package_asset_truncated')
      }
      await assertManifestFingerprint(verified.root, verified.manifestFingerprint)
      throwIfAborted(options.signal)
      return MobileWebPackageAssetChunkSchema.parse({
        buildId: verified.manifest.buildId,
        path: asset.path,
        offset: params.offset,
        byteLength,
        sha256: sha256(bytes),
        dataBase64: bytes.toString('base64'),
        eof: params.offset + byteLength === asset.byteLength
      })
    } finally {
      release()
    }
  }

  private async getVerifiedPackage(): Promise<VerifiedMobileWebPackage> {
    const root = this.resolveRoot()
    const manifestBytes = await readManifestBytes(root)
    const fingerprint = sha256(manifestBytes)
    if (this.cached?.fingerprint === fingerprint && this.cached.package.root === root) {
      return this.cached.package
    }
    if (this.verifying?.fingerprint === fingerprint && this.verifying.root === root) {
      return this.verifying.promise
    }
    const promise = verifyPackage(root, manifestBytes, fingerprint)
    this.verifying = { root, fingerprint, promise }
    try {
      const verified = await promise
      this.gzipChunks.clear()
      this.cached = { fingerprint, package: verified }
      return verified
    } finally {
      if (this.verifying?.promise === promise) {
        this.verifying = null
      }
    }
  }

  async getAssetGzipChunk(
    params: MobileWebPackageAssetParams,
    options: { connectionId?: string; signal?: AbortSignal } = {}
  ): Promise<MobileWebPackageGzipAssetChunk> {
    throwIfAborted(options.signal)
    const verified = await this.getVerifiedPackage()
    const asset = this.validateAssetParams(verified, params)
    const key = `${params.buildId}:${params.path}:${params.offset}`
    let compressed = this.gzipChunks.get(key)
    let raw: MobileWebPackageAssetChunk
    if (!compressed) {
      raw = await this.getAssetChunk(params, options)
      compressed = gzipSync(Buffer.from(raw.dataBase64, 'base64'), { level: 6 })
      this.gzipChunks.set(key, compressed)
    } else {
      const path = resolveDeclaredAssetPath(verified.root, asset.path)
      const expectedStat = verified.fileStatsByPath.get(asset.path)!
      const currentStat = await stat(path)
      if (currentStat.size !== expectedStat.size || currentStat.mtimeMs !== expectedStat.mtimeMs) {
        this.cached = null
        throw new Error('mobile_web_package_asset_changed')
      }
      await assertManifestFingerprint(verified.root, verified.manifestFingerprint)
      const rawByteLength = Math.min(
        MOBILE_WEB_PACKAGE_CHUNK_BYTES,
        asset.byteLength - params.offset
      )
      raw = {
        buildId: verified.manifest.buildId,
        path: asset.path,
        offset: params.offset,
        byteLength: rawByteLength,
        sha256: '',
        dataBase64: '',
        eof: params.offset + rawByteLength === asset.byteLength
      }
    }
    return MobileWebPackageGzipAssetChunkSchema.parse({
      buildId: raw.buildId,
      path: raw.path,
      offset: raw.offset,
      sourceByteLength: raw.byteLength,
      byteLength: compressed.byteLength,
      sha256: sha256(compressed),
      dataBase64: compressed.toString('base64'),
      eof: raw.eof,
      encoding: 'gzip'
    })
  }

  private validateAssetParams(
    verified: VerifiedMobileWebPackage,
    params: MobileWebPackageAssetParams
  ): MobileWebAsset {
    if (params.buildId !== verified.manifest.buildId) {
      throw new Error('mobile_web_package_build_changed')
    }
    const asset = verified.assetsByPath.get(params.path)
    if (!asset) {
      throw new Error('mobile_web_package_asset_unknown')
    }
    if (params.offset >= asset.byteLength || params.offset % MOBILE_WEB_PACKAGE_CHUNK_BYTES !== 0) {
      throw new Error('mobile_web_package_offset_invalid')
    }
    return asset
  }

  private acquireRead(connectionId: string, bytes: number): () => void {
    const state = this.readStates.get(connectionId) ?? { count: 0, bytes: 0 }
    if (
      state.count >= MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS ||
      state.bytes + bytes > MOBILE_WEB_PACKAGE_MAX_IN_FLIGHT_BYTES
    ) {
      throw new Error('mobile_web_package_read_limited')
    }
    state.count += 1
    state.bytes += bytes
    this.readStates.set(connectionId, state)
    return () => {
      state.count -= 1
      state.bytes -= bytes
      if (state.count === 0) {
        this.readStates.delete(connectionId)
      }
    }
  }
}

async function verifyPackage(
  root: string,
  manifestBytes: Buffer,
  manifestFingerprint: string
): Promise<VerifiedMobileWebPackage> {
  const manifest = parseManifest(manifestBytes)
  if (sha256(serializeMobileWebManifestForBuildId(manifest)) !== manifest.buildId) {
    throw new Error('mobile_web_package_build_invalid')
  }
  const fileStatsByPath = new Map<string, { size: number; mtimeMs: number }>()
  for (const asset of manifest.assets) {
    const path = resolveDeclaredAssetPath(root, asset.path)
    const beforeRead = await stat(path)
    const bytes = await readFile(path)
    const afterRead = await stat(path)
    if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) {
      throw new Error('mobile_web_package_asset_invalid')
    }
    if (beforeRead.size !== afterRead.size || beforeRead.mtimeMs !== afterRead.mtimeMs) {
      throw new Error('mobile_web_package_asset_changed')
    }
    fileStatsByPath.set(asset.path, { size: afterRead.size, mtimeMs: afterRead.mtimeMs })
  }
  await assertManifestFingerprint(root, manifestFingerprint)
  return {
    root,
    manifestFingerprint,
    manifest,
    assetsByPath: new Map(manifest.assets.map((asset) => [asset.path, asset])),
    fileStatsByPath
  }
}

function parseManifest(manifestBytes: Buffer): MobileWebManifest {
  try {
    return MobileWebManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
  } catch {
    throw new Error('mobile_web_package_build_invalid')
  }
}

async function readManifestBytes(root: string): Promise<Buffer> {
  try {
    return await readFile(resolve(root, 'manifest.json'))
  } catch {
    throw new Error('mobile_web_package_unavailable')
  }
}

async function assertManifestFingerprint(root: string, expected: string): Promise<void> {
  if (sha256(await readManifestBytes(root)) !== expected) {
    throw new Error('mobile_web_package_build_changed')
  }
}

function resolveDeclaredAssetPath(root: string, assetPath: string): string {
  const candidate = resolve(root, ...assetPath.split('/'))
  const child = relative(root, candidate)
  if (child.startsWith('..') || isAbsolute(child)) {
    throw new Error('mobile_web_package_asset_path_invalid')
  }
  return candidate
}

async function readAssetRange(path: string, offset: number, length: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('mobile_web_package_cancelled')
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export const mobileWebPackageAssets = new MobileWebPackageAssets()
