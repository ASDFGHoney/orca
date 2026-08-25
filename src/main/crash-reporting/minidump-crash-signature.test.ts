import { describe, expect, it } from 'vitest'
import { minidumpSignatureDetails, parseMinidumpCrashSignature } from './minidump-crash-signature'
import { appendMinidumpSignatureLines } from '../../shared/crash-report-signature-lines'

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_EXCEPTION = 6
const STREAM_TYPE_CRASHPAD_INFO = 0x43500001
const STREAM_TYPE_SYSTEM_INFO = 7

const PLATFORM_ID_WIN32_NT = 2
const PLATFORM_ID_MAC_OS_X = 0x8101
const PLATFORM_ID_LINUX = 0x8201
const CPU_ARCHITECTURE_AMD64 = 9
const CPU_ARCHITECTURE_ARM64 = 12
const CPU_ARCHITECTURE_ARM32 = 5

const WINDOWS_X64 = { platformId: PLATFORM_ID_WIN32_NT, architecture: CPU_ARCHITECTURE_AMD64 }
const LINUX_X64 = { platformId: PLATFORM_ID_LINUX, architecture: CPU_ARCHITECTURE_AMD64 }
const MAC_ARM64 = { platformId: PLATFORM_ID_MAC_OS_X, architecture: CPU_ARCHITECTURE_ARM64 }

/** CONTEXT_AMD64 with Rip at its documented offset. */
function amd64Context(rip: bigint): Buffer {
  const buf = Buffer.alloc(1232)
  buf.writeUInt32LE(0x0010_000f, 48)
  buf.writeBigUInt64LE(rip, 248)
  return buf
}

/** Crashpad MinidumpContextARM64 with pc at its documented offset. */
function arm64Context(pc: bigint): Buffer {
  const buf = Buffer.alloc(912)
  buf.writeUInt32LE(0x0040_0003, 0)
  buf.writeBigUInt64LE(pc, 264)
  return buf
}

/**
 * Builds real Crashpad-layout minidumps so the parser is tested against the
 * byte format rather than a mock. Regions are appended and referenced by RVA,
 * matching how Crashpad emits them.
 */
class MinidumpBuilder {
  private regions: Buffer[] = []
  private cursor = 0

  constructor(private readonly headerAndDirectoryBytes: number) {
    this.cursor = headerAndDirectoryBytes
  }

  append(buf: Buffer): number {
    const rva = this.cursor
    this.regions.push(buf)
    this.cursor += buf.length
    return rva
  }

  utf8String(value: string): number {
    const data = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(4 + data.length + 1)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  utf16String(value: string): number {
    const data = Buffer.from(value, 'utf16le')
    const buf = Buffer.alloc(4 + data.length + 2)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  byteArray(value: string): number {
    const data = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(4 + data.length)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  build(streams: { type: number; size: number; rva: number }[]): Buffer {
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0x504d444d, 0)
    header.writeUInt32LE(0xa793, 4)
    header.writeUInt32LE(streams.length, 8)
    header.writeUInt32LE(32, 12)
    const directory = Buffer.alloc(streams.length * 12)
    streams.forEach((stream, index) => {
      directory.writeUInt32LE(stream.type, index * 12)
      directory.writeUInt32LE(stream.size, index * 12 + 4)
      directory.writeUInt32LE(stream.rva, index * 12 + 8)
    })
    const body = Buffer.concat(this.regions)
    const prefix = Buffer.concat([header, directory])
    expect(prefix.length).toBe(this.headerAndDirectoryBytes)
    return Buffer.concat([prefix, body])
  }
}

function location(size: number, rva: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt32LE(size, 0)
  buf.writeUInt32LE(rva, 4)
  return buf
}

const EMPTY_LOCATION = location(0, 0)

type BuiltDump = { dump: Buffer }

/**
 * @param annotations key/value pairs written as MinidumpAnnotation objects
 *   hanging off a module's crashpad info, which is where Chromium crash keys
 *   (including LOG_FATAL) actually live.
 */
function buildDump(options: {
  annotations?: Record<string, string>
  simpleAnnotations?: Record<string, string>
  exception?: { code: number; address: bigint; threadContext?: Buffer }
  modules?: { base: bigint; size: number; name: string }[]
  /** Count written into the module list header, as a corrupt dump would carry. */
  declaredModuleCount?: number
  systemInfo?: { platformId: number; architecture: number }
}): BuiltDump {
  const streamCount =
    1 +
    (options.exception ? 1 : 0) +
    (options.modules && options.modules.length > 0 ? 1 : 0) +
    (options.systemInfo ? 1 : 0)
  const builder = new MinidumpBuilder(32 + streamCount * 12)
  const streams: { type: number; size: number; rva: number }[] = []

  // Module-level annotation objects.
  const annotationEntries = Object.entries(options.annotations ?? {})
  const annotationRecords = annotationEntries.map(([name, value]) => ({
    nameRva: builder.utf8String(name),
    valueRva: builder.byteArray(value)
  }))
  const annotationListBuf = Buffer.alloc(4 + annotationRecords.length * 12)
  annotationListBuf.writeUInt32LE(annotationRecords.length, 0)
  annotationRecords.forEach((record, index) => {
    const at = 4 + index * 12
    annotationListBuf.writeUInt32LE(record.nameRva, at)
    annotationListBuf.writeUInt16LE(1, at + 4) // kString
    annotationListBuf.writeUInt16LE(0, at + 6)
    annotationListBuf.writeUInt32LE(record.valueRva, at + 8)
  })
  const annotationListRva = builder.append(annotationListBuf)

  // Process-level simple string dictionary.
  const simpleEntries = Object.entries(options.simpleAnnotations ?? {})
  const simplePairs = simpleEntries.map(([key, value]) => ({
    keyRva: builder.utf8String(key),
    valueRva: builder.utf8String(value)
  }))
  const simpleBuf = Buffer.alloc(4 + simplePairs.length * 8)
  simpleBuf.writeUInt32LE(simplePairs.length, 0)
  simplePairs.forEach((pair, index) => {
    simpleBuf.writeUInt32LE(pair.keyRva, 4 + index * 8)
    simpleBuf.writeUInt32LE(pair.valueRva, 4 + index * 8 + 4)
  })
  const simpleRva = builder.append(simpleBuf)

  // MinidumpModuleCrashpadInfo (version, list_annotations, simple, objects).
  const moduleInfoBuf = Buffer.concat([
    (() => {
      const v = Buffer.alloc(4)
      v.writeUInt32LE(1, 0)
      return v
    })(),
    EMPTY_LOCATION,
    EMPTY_LOCATION,
    location(annotationListBuf.length, annotationListRva)
  ])
  const moduleInfoRva = builder.append(moduleInfoBuf)

  const moduleLinkBuf = Buffer.alloc(4 + 12)
  moduleLinkBuf.writeUInt32LE(1, 0)
  moduleLinkBuf.writeUInt32LE(0, 4) // minidump module index
  moduleLinkBuf.writeUInt32LE(moduleInfoBuf.length, 8)
  moduleLinkBuf.writeUInt32LE(moduleInfoRva, 12)
  const moduleLinkRva = builder.append(moduleLinkBuf)

  const crashpadInfoBuf = Buffer.concat([
    (() => {
      const v = Buffer.alloc(4 + 16 + 16)
      v.writeUInt32LE(1, 0)
      return v
    })(),
    location(simpleBuf.length, simpleRva),
    location(moduleLinkBuf.length, moduleLinkRva)
  ])
  const crashpadInfoRva = builder.append(crashpadInfoBuf)
  streams.push({
    type: STREAM_TYPE_CRASHPAD_INFO,
    size: crashpadInfoBuf.length,
    rva: crashpadInfoRva
  })

  if (options.modules && options.modules.length > 0) {
    const nameRvas = options.modules.map((module) => builder.utf16String(module.name))
    const listBuf = Buffer.alloc(4 + options.modules.length * 108)
    listBuf.writeUInt32LE(options.declaredModuleCount ?? options.modules.length, 0)
    options.modules.forEach((module, index) => {
      const at = 4 + index * 108
      listBuf.writeBigUInt64LE(module.base, at)
      listBuf.writeUInt32LE(module.size, at + 8)
      listBuf.writeUInt32LE(nameRvas[index], at + 20)
    })
    streams.push({
      type: STREAM_TYPE_MODULE_LIST,
      size: listBuf.length,
      rva: builder.append(listBuf)
    })
  }

  if (options.systemInfo) {
    const systemInfoBuf = Buffer.alloc(56)
    systemInfoBuf.writeUInt16LE(options.systemInfo.architecture, 0)
    systemInfoBuf.writeUInt32LE(options.systemInfo.platformId, 20)
    streams.push({
      type: STREAM_TYPE_SYSTEM_INFO,
      size: systemInfoBuf.length,
      rva: builder.append(systemInfoBuf)
    })
  }

  if (options.exception) {
    const contextRva = options.exception.threadContext
      ? builder.append(options.exception.threadContext)
      : 0
    const exceptionBuf = Buffer.alloc(168)
    exceptionBuf.writeUInt32LE(1234, 0) // ThreadId
    exceptionBuf.writeUInt32LE(options.exception.code, 8)
    exceptionBuf.writeBigUInt64LE(options.exception.address, 24)
    // MINIDUMP_EXCEPTION_STREAM.ThreadContext, after the 152-byte MINIDUMP_EXCEPTION.
    exceptionBuf.writeUInt32LE(options.exception.threadContext?.length ?? 0, 160)
    exceptionBuf.writeUInt32LE(contextRva, 164)
    streams.push({
      type: STREAM_TYPE_EXCEPTION,
      size: exceptionBuf.length,
      rva: builder.append(exceptionBuf)
    })
  }

  return { dump: builder.build(streams) }
}

const FATAL_LINE =
  '[8104:1234:0815/143022.123456:FATAL:render_frame_impl.cc(4821)] Check failed: !is_detached_.'

const ELECTRON_43_CHECK_LINE =
  '[29136:0815/232206.330:ERROR:third_party\\blink\\common\\chrome_debug_urls.cc:180] Intentionally causing CHECK because user navigated to chrome://checkcrash/'

describe('parseMinidumpCrashSignature', () => {
  it('names the failing CHECK from the LOG_FATAL annotation', () => {
    const { dump } = buildDump({
      annotations: { LOG_FATAL: FATAL_LINE, ptype: 'renderer' }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.checkMessage).toBe(FATAL_LINE)
    expect(signature?.checkFile).toBe('render_frame_impl.cc')
    expect(signature?.checkLine).toBe(4821)
    expect(signature?.processType).toBe('renderer')
  })

  it('recovers a CHECK line from Electron 43 dump memory without LOG_FATAL', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory)

    expect(signature?.checkMessage).toBe(ELECTRON_43_CHECK_LINE)
    expect(signature?.checkFile).toBe('chrome_debug_urls.cc')
    expect(signature?.checkLine).toBe(180)
    expect(signature?.processType).toBe('renderer')
  })

  it('stops at the process type when the dump belongs to another process', () => {
    const { dump } = buildDump({ annotations: { ptype: 'gpu-process' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory, {
      expectedProcessType: 'renderer'
    })

    expect(signature?.processType).toBe('gpu-process')
    // The whole-buffer scan is skipped; the caller discards this dump anyway.
    expect(signature?.checkMessage).toBeUndefined()
  })

  it('still parses fully when the process type matches', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory, {
      expectedProcessType: 'renderer'
    })

    expect(signature?.checkMessage).toBe(ELECTRON_43_CHECK_LINE)
  })

  it('ignores a log prefix further back than the prefix limit', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    // `[` separated from the marker by more than MAX_LOG_PREFIX_BYTES (96).
    const farPrefix = `[${'x'.repeat(200)}:FATAL:render_frame_impl.cc(4821)] Check failed: far.`
    const dumpWithMemory = Buffer.concat([dump, Buffer.from(`\0${farPrefix}\0`, 'utf8')])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBeUndefined()
  })

  it('does not promote an unrelated Chromium ERROR line containing CHECK', () => {
    const { dump } = buildDump({})
    const unrelated =
      '[29136:0815/232206.330:ERROR:settings.cc:44] Opened the CHECK settings panel.'
    const dumpWithMemory = Buffer.concat([dump, Buffer.from(`\0${unrelated}\0`, 'utf8')])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBeUndefined()
  })

  it('prefers the structured annotation over a dump-memory candidate', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBe(FATAL_LINE)
  })

  it('reads annotations from the process-level simple string dictionary', () => {
    const { dump } = buildDump({
      simpleAnnotations: {
        ptype: 'gpu-process',
        'gpu-gl-vendor': 'Intel Inc.'
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.processType).toBe('gpu-process')
    expect(signature?.annotations['gpu-gl-vendor']).toBe('Intel Inc.')
  })

  it('drops annotations outside the allowlist', () => {
    const { dump } = buildDump({
      annotations: {
        LOG_FATAL: FATAL_LINE,
        'switch-3': '--user-data-dir=/Users/someone/secret'
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.annotations['switch-3']).toBeUndefined()
    expect(Object.keys(signature?.annotations ?? {})).toEqual(['LOG_FATAL'])
  })

  it('resolves the faulting module from a Windows exception address', () => {
    const { dump } = buildDump({
      systemInfo: WINDOWS_X64,
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [
        {
          base: 0x7ff7_0000_0000n,
          size: 0x1000,
          name: 'C:\\Program Files\\Orca\\Orca.exe'
        },
        {
          base: 0x7ff8_0000_0000n,
          size: 0x10_0000,
          name: 'C:\\Program Files\\Orca\\chrome_elf.dll'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionCode).toBe(0x80000003)
    expect(signature?.exceptionAddress).toBe('0x7ff800001234')
    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleOffset).toBe('0x1234')
    expect(signature?.faultingModuleUnavailable).toBeUndefined()
  })

  it('reports why no image range covers a Windows exception address', () => {
    const { dump } = buildDump({
      systemInfo: WINDOWS_X64,
      exception: { code: 0xc000_0005, address: 0x10n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: 'C:\\Orca\\Orca.exe' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionAddress).toBe('0x10')
    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleUnavailable).toContain('0x10')
  })

  // Crash 1.4.188 / linux x64 SIGSEGV: exception address 0x27d787ec0000 is
  // siginfo.si_addr, so a module covering it names the owner of the bad pointer.
  it('never names a module from a POSIX signal exception address', () => {
    const { dump } = buildDump({
      systemInfo: LINUX_X64,
      exception: { code: 11, address: 0x27d7_87ec_0000n },
      modules: [
        { base: 0x27d7_87ec_0000n, size: 0x10_0000, name: '/opt/orca/libffmpeg.so' },
        { base: 0x5566_0000_0000n, size: 0x10_0000, name: '/opt/orca/orca' }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionAddress).toBe('0x27d787ec0000')
    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleOffset).toBeUndefined()
    expect(signature?.faultingModuleUnavailable).toMatch(/instruction pointer/i)
  })

  // Same crash shape, but with the thread context Crashpad normally writes.
  it('names the module from the thread-context instruction pointer on Linux', () => {
    const { dump } = buildDump({
      systemInfo: LINUX_X64,
      exception: {
        code: 11,
        address: 0x3f76_057d_ffbcn,
        threadContext: amd64Context(0x5566_0000_2345n)
      },
      modules: [
        { base: 0x3f76_0000_0000n, size: 0x1000_0000, name: '/opt/orca/libffmpeg.so' },
        { base: 0x5566_0000_0000n, size: 0x10_0000, name: '/opt/orca/libGLESv2.so' }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionAddress).toBe('0x3f76057dffbc')
    expect(signature?.faultingModule).toBe('libGLESv2.so')
    expect(signature?.faultingModuleOffset).toBe('0x2345')
    expect(signature?.faultingModuleUnavailable).toBeUndefined()
  })

  it('reads the instruction pointer from an arm64 macOS thread context', () => {
    const { dump } = buildDump({
      systemInfo: MAC_ARM64,
      exception: {
        code: 10,
        address: 0x1n,
        threadContext: arm64Context(0x1_0400_0100n)
      },
      modules: [
        { base: 0x1_0000_0000n, size: 0x1000, name: '/Applications/Orca.app/Contents/MacOS/Orca' },
        {
          base: 0x1_0400_0000n,
          size: 0x10_0000,
          name: '/Applications/Orca.app/Contents/Frameworks/Electron Framework'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('Electron Framework')
    expect(signature?.faultingModuleOffset).toBe('0x100')
  })

  it('says the module is unavailable when a POSIX dump carries no thread context', () => {
    const { dump } = buildDump({
      systemInfo: LINUX_X64,
      exception: { code: 11, address: 0x27d7_87ec_0000n },
      modules: [{ base: 0x5566_0000_0000n, size: 0x10_0000, name: '/opt/orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleUnavailable).toMatch(/thread context/i)
  })

  // Distrusting the exception address is a POSIX rule; a dump that never says
  // which OS it came from must not lose an attribution over it.
  it('still resolves a Windows exception address when the dump carries no system info', () => {
    const { dump } = buildDump({
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleOffset).toBe('0x1234')
    expect(signature?.faultingModuleUnavailable).toBeUndefined()
  })

  // The unavailable reason is read as a debugging assertion: the fallback path
  // has explicitly declined to establish that the value is an instruction pointer.
  it('names the exception address, not an instruction pointer, in the out-of-range reason', () => {
    const { dump } = buildDump({
      systemInfo: WINDOWS_X64,
      exception: { code: 0xc000_0005, address: 0x10n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: 'C:\\Orca\\Orca.exe' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModuleUnavailable).toBe(
      'exception address 0x10 is outside every loaded module'
    )
    expect(signature?.faultingModuleUnavailable).not.toMatch(/instruction pointer/i)
  })

  // The loop-1 crash again, minus the SYSTEM_INFO stream: the parser cannot tell
  // this from a Windows dump, so it must publish the module with the caveat
  // rather than as a confident instruction-pointer attribution.
  it('caveats a module named from the exception address of an unidentified platform', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x27d7_87ec_0000n },
      modules: [
        { base: 0x27d7_87ec_0000n, size: 0x10_0000, name: '/opt/orca/libffmpeg.so' },
        { base: 0x5566_0000_0000n, size: 0x10_0000, name: '/opt/orca/orca' }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('libffmpeg.so')
    expect(signature?.faultingModuleOffset).toBe('0x0')
    expect(signature?.faultingModuleCaveat).toBe(
      'named from the exception address; this dump does not say which OS it came from, so that may be the faulting data address rather than the instruction pointer'
    )
    expect(minidumpSignatureDetails(signature!).minidumpFaultingModuleCaveat).toBe(
      signature?.faultingModuleCaveat
    )
  })

  it('caveats a module named from the exception address of an unrecognised platform id', () => {
    const { dump } = buildDump({
      systemInfo: { platformId: 0x7fff, architecture: CPU_ARCHITECTURE_AMD64 },
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleCaveat).toMatch(/exception address/i)
  })

  // A dump that names a Windows platform id is not guessing: ExceptionAddress is
  // the instruction pointer there, so the caveat would be noise.
  it('does not caveat a module named from a Windows exception address', () => {
    const { dump } = buildDump({
      systemInfo: WINDOWS_X64,
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleCaveat).toBeUndefined()
    expect(minidumpSignatureDetails(signature!).minidumpFaultingModuleCaveat).toBeUndefined()
  })

  // An instruction pointer read from the thread context is never a guess.
  it('does not caveat a module named from the thread-context instruction pointer', () => {
    const { dump } = buildDump({
      systemInfo: LINUX_X64,
      exception: {
        code: 11,
        address: 0x3f76_057d_ffbcn,
        threadContext: amd64Context(0x5566_0000_2345n)
      },
      modules: [{ base: 0x5566_0000_0000n, size: 0x10_0000, name: '/opt/orca/libGLESv2.so' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('libGLESv2.so')
    expect(signature?.faultingModuleCaveat).toBeUndefined()
  })

  it('still resolves an exception address when the platform id is unrecognised', () => {
    const { dump } = buildDump({
      systemInfo: { platformId: 0x7fff, architecture: CPU_ARCHITECTURE_AMD64 },
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleOffset).toBe('0x1234')
  })

  it('does not claim a missing thread context when the architecture is unmapped', () => {
    const { dump } = buildDump({
      systemInfo: { platformId: PLATFORM_ID_LINUX, architecture: CPU_ARCHITECTURE_ARM32 },
      exception: { code: 11, address: 0x27d7_87ec_0000n, threadContext: arm64Context(0x1n) },
      modules: [{ base: 0x5566_0000_0000n, size: 0x10_0000, name: '/opt/orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleUnavailable).not.toMatch(/no thread context/i)
    expect(signature?.faultingModuleUnavailable).toMatch(/architecture/i)
  })

  it('distinguishes a truncated thread context from an absent one', () => {
    const { dump } = buildDump({
      systemInfo: LINUX_X64,
      exception: { code: 11, address: 0x27d7_87ec_0000n, threadContext: Buffer.alloc(64) },
      modules: [{ base: 0x5566_0000_0000n, size: 0x10_0000, name: '/opt/orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleUnavailable).not.toMatch(/no thread context/i)
    expect(signature?.faultingModuleUnavailable).toMatch(/truncat/i)
  })

  // SYSTEM_INFO describes the machine and can disagree with the CONTEXT actually
  // stored; reading an ARM64 pc out of a CONTEXT_AMD64 yields a plausible zero.
  it('falls back to the exception address when the context is not the named architecture', () => {
    const { dump } = buildDump({
      systemInfo: { platformId: PLATFORM_ID_WIN32_NT, architecture: CPU_ARCHITECTURE_ARM64 },
      exception: {
        code: 0xc000_0005,
        address: 0x7ff8_0000_1234n,
        threadContext: amd64Context(0x7ff8_0000_1234n)
      },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleOffset).toBe('0x1234')
    expect(signature?.faultingModuleUnavailable).toBeUndefined()
  })

  // Breakpad records the main executable with an empty l_name; an empty basename
  // would drop the whole line and leave an orphan offset detail behind.
  it('still names a module whose recorded name has no basename', () => {
    const { dump } = buildDump({
      systemInfo: LINUX_X64,
      exception: { code: 11, address: 0x1n, threadContext: amd64Context(0x5566_0000_0500n) },
      modules: [{ base: 0x5566_0000_0000n, size: 0x10_0000, name: '' }]
    })

    const signature = parseMinidumpCrashSignature(dump)
    const details = minidumpSignatureDetails(signature!)
    const lines: string[] = []
    appendMinidumpSignatureLines(lines, details)

    expect(signature?.faultingModule).not.toBe('')
    expect(details.minidumpFaultingModule).toBeDefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('+0x500')
  })

  it('says the module list could not be read rather than that the dump carries none', () => {
    const { dump } = buildDump({
      systemInfo: WINDOWS_X64,
      exception: { code: 0xc000_0005, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }],
      declaredModuleCount: 5_000
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModuleUnavailable).not.toMatch(/carries no module list/)
    expect(signature?.faultingModuleUnavailable).toMatch(/could not be read/)
  })

  it('does not claim exhaustive coverage from a module list it could only read part of', () => {
    const { dump } = buildDump({
      systemInfo: WINDOWS_X64,
      exception: { code: 0xc000_0005, address: 0xdead_beef_0000_0010n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }],
      declaredModuleCount: 900
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleUnavailable).toMatch(/truncat/i)
  })

  it('returns null for a buffer that is not a minidump', () => {
    expect(parseMinidumpCrashSignature(Buffer.from('not a dump at all', 'utf8'))).toBeNull()
    expect(parseMinidumpCrashSignature(Buffer.alloc(0))).toBeNull()
  })

  it('degrades instead of throwing on a truncated dump', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })

    const truncated = dump.subarray(0, 48)

    expect(() => parseMinidumpCrashSignature(truncated)).not.toThrow()
    expect(parseMinidumpCrashSignature(truncated)?.checkMessage).toBeUndefined()
  })

  it('degrades instead of throwing when stream counts are corrupt', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })
    const corrupt = Buffer.from(dump)
    corrupt.writeUInt32LE(0xffff_ffff, 8)

    expect(() => parseMinidumpCrashSignature(corrupt)).not.toThrow()
    expect(parseMinidumpCrashSignature(corrupt)?.annotations).toEqual({})
  })
})

describe('minidumpSignatureDetails', () => {
  it('flattens the check location and faulting module into detail keys', () => {
    const { dump } = buildDump({
      annotations: {
        LOG_FATAL: FATAL_LINE,
        ptype: 'renderer',
        channel: 'stable'
      },
      systemInfo: WINDOWS_X64,
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details).toMatchObject({
      minidumpCheckMessage: FATAL_LINE,
      minidumpCheckFile: 'render_frame_impl.cc',
      minidumpCheckLine: 4821,
      minidumpProcessType: 'renderer',
      minidumpExceptionCode: '0x80000003',
      minidumpFaultingModule: 'chrome_elf.dll',
      minidumpAnnotation_channel: 'stable'
    })
  })

  it('flattens the unavailable reason so the report never silently omits it', () => {
    const { dump } = buildDump({
      systemInfo: LINUX_X64,
      annotations: { ptype: 'renderer' },
      exception: { code: 11, address: 0x27d7_87ec_0000n },
      modules: [{ base: 0x27d7_87ec_0000n, size: 0x10_0000, name: '/opt/orca/libffmpeg.so' }]
    })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details.minidumpFaultingModule).toBeUndefined()
    expect(typeof details.minidumpFaultingModuleUnavailable).toBe('string')
  })

  it('does not duplicate the fatal line into an annotation key', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details.minidumpAnnotation_LOG_FATAL).toBeUndefined()
  })
})
