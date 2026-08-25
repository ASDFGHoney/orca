// Names the loaded module that owns the crashing instruction.
//
// Why this is not simply "the module containing ExceptionAddress": that record
// field is the instruction pointer only on Windows. Crashpad fills it from
// siginfo.si_addr on POSIX, so for SIGSEGV/SIGBUS it is the faulting *data*
// address — resolving a module from it names whatever owns the bad pointer
// rather than the code that dereferenced it. The instruction pointer lives in
// the exception stream's thread context, so that is where it is read from, and
// when it is missing we say exactly which piece was missing instead of
// guessing — including when the stored context contradicts the architecture
// SYSTEM_INFO names, since reading a pointer out of the wrong CONTEXT layout
// yields a confident wrong answer. Only a dump that identifies itself as POSIX
// is distrusted this way; otherwise the exception address stays a fallback —
// marked with a caveat unless the dump names a Windows platform, where it
// really is the pointer.

import {
  findStream,
  type LocationDescriptor,
  MAX_MODULES,
  type MinidumpView
} from './minidump-stream-reader'

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_SYSTEM_INFO = 7

const MODULE_RECORD_SIZE = 108
const MODULE_BASE_OFFSET = 0
const MODULE_SIZE_OFFSET = 8
const MODULE_NAME_RVA_OFFSET = 20

// MINIDUMP_SYSTEM_INFO.
const SYSTEM_INFO_ARCHITECTURE_OFFSET = 0
const SYSTEM_INFO_PLATFORM_ID_OFFSET = 20

// MINIDUMP_EXCEPTION_STREAM: ThreadId u32, __alignment u32, the 152-byte
// MINIDUMP_EXCEPTION, then the thread's context location descriptor.
const THREAD_CONTEXT_OFFSET = 160

// Breakpad/Crashpad number every POSIX OS from 0x8000 up (MD_OS_UNIX and its
// per-OS successors); Windows keeps the low VER_PLATFORM_* ids.
const PLATFORM_ID_POSIX_MIN = 0x8000
// VER_PLATFORM_WIN32s/WIN32_WINDOWS/WIN32_NT/WIN32_CE.
const PLATFORM_ID_WINDOWS_MAX = 3

const CPU_ARCHITECTURE_X86 = 0
const CPU_ARCHITECTURE_AMD64 = 9
const CPU_ARCHITECTURE_ARM64 = 12
// Breakpad numbered arm64 differently; dumps carrying that id are still read.
const CPU_ARCHITECTURE_ARM64_BREAKPAD = 0x8003

// CONTEXT.ContextFlags carries the CPU in its high bits; the low byte is the
// per-register-group selection.
const CONTEXT_CPU_MASK = 0xffffff00
const CONTEXT_CPU_X86 = 0x0001_0000
const CONTEXT_CPU_AMD64 = 0x0010_0000
const CONTEXT_CPU_ARM64 = 0x0040_0000
// Breakpad's older arm64 flag; both spellings reach us.
const CONTEXT_CPU_ARM64_OLD = 0x8000_0000
const KNOWN_CONTEXT_CPUS = new Set([
  CONTEXT_CPU_X86,
  CONTEXT_CPU_AMD64,
  CONTEXT_CPU_ARM64,
  CONTEXT_CPU_ARM64_OLD
])
// CONTEXT_AMD64 alone puts ContextFlags after the six home-parameter slots.
const AMD64_CONTEXT_FLAGS_OFFSET = 48
const AMD64_CONTEXT_SIZE = 1232

const ARM64_CONTEXT_CPUS = [CONTEXT_CPU_ARM64, CONTEXT_CPU_ARM64_OLD]

/** Where the instruction pointer sits in each CONTEXT layout, by architecture. */
const INSTRUCTION_POINTER_LAYOUTS = new Map<
  number,
  { offset: number; bytes: 4 | 8; cpus: readonly number[] }
>([
  // CONTEXT_X86.Eip
  [CPU_ARCHITECTURE_X86, { offset: 184, bytes: 4, cpus: [CONTEXT_CPU_X86] }],
  // CONTEXT_AMD64.Rip
  [CPU_ARCHITECTURE_AMD64, { offset: 248, bytes: 8, cpus: [CONTEXT_CPU_AMD64] }],
  // MinidumpContextARM64.pc
  [CPU_ARCHITECTURE_ARM64, { offset: 264, bytes: 8, cpus: ARM64_CONTEXT_CPUS }],
  // iregs[32] lands there too
  [CPU_ARCHITECTURE_ARM64_BREAKPAD, { offset: 264, bytes: 8, cpus: ARM64_CONTEXT_CPUS }]
])

// One string per distinct cause: the report is read by someone debugging the
// crash, so "context missing" must not be printed when the context is present.
const NO_SYSTEM_INFO =
  'the dump carries no readable system info, so the thread context layout is unknown'
const NO_THREAD_CONTEXT = 'no thread context in this dump'
const TRUNCATED_THREAD_CONTEXT = 'the thread context in this dump is truncated'
const POSIX_ADDRESS_CAVEAT =
  'the exception address is the faulting data address on POSIX, not the instruction pointer'
const NO_MODULE_LIST = 'the dump carries no module list'
const UNREADABLE_MODULE_LIST = "the dump's module list could not be read"
const NO_MODULES_LISTED = "the dump's module list is empty"
const CONTEXT_ARCHITECTURE_MISMATCH =
  'the thread context in this dump is not the layout for the CPU architecture it names'
const UNIDENTIFIED_PLATFORM_CAVEAT =
  'named from the exception address; this dump does not say which OS it came from, so that may be the faulting data address rather than the instruction pointer'

export type FaultingModule =
  | {
      readonly name: string
      readonly offset: string
      /** Set when the address used was not a verified instruction pointer. */
      readonly caveat?: string
      readonly unavailable?: undefined
    }
  | {
      readonly name?: undefined
      readonly offset?: undefined
      readonly caveat?: undefined
      readonly unavailable: string
    }

type ModuleRecord = {
  readonly base: bigint
  readonly size: number
  readonly name: string
}

/** Basename of a path recorded in a dump, which may use either separator. */
export function dumpPathBasename(recordedPath: string): string {
  const separator = Math.max(recordedPath.lastIndexOf('/'), recordedPath.lastIndexOf('\\'))
  return separator >= 0 ? recordedPath.slice(separator + 1) : recordedPath
}

/** `complete` false means the list is there but was not read end to end, so it
 * cannot be cited as proof that an address belongs to no module. */
type ModuleList = { readonly modules: ModuleRecord[]; readonly complete: boolean }

function readModules(view: MinidumpView): ModuleList | null {
  const stream = findStream(view, STREAM_TYPE_MODULE_LIST)
  if (!stream) {
    return null
  }
  const count = view.u32(stream.rva)
  if (count === null || count > MAX_MODULES) {
    return { modules: [], complete: false }
  }
  const modules: ModuleRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const record = stream.rva + 4 + index * MODULE_RECORD_SIZE
    const base = view.u64(record + MODULE_BASE_OFFSET)
    const size = view.u32(record + MODULE_SIZE_OFFSET)
    const nameRva = view.u32(record + MODULE_NAME_RVA_OFFSET)
    if (base === null || size === null || nameRva === null) {
      return { modules, complete: false }
    }
    const name = view.utf16String(nameRva, 2_048)
    modules.push({ base, size, name: name ?? 'unknown' })
  }
  return { modules, complete: true }
}

/** Which CPU the stored context says it is, or null when it names none we know. */
function contextCpu(view: MinidumpView, context: LocationDescriptor): number | null {
  const named = (flags: number | null): number | null => {
    const cpu = flags === null ? null : flags & CONTEXT_CPU_MASK
    return cpu !== null && KNOWN_CONTEXT_CPUS.has(cpu) ? cpu : null
  }
  const amd64 =
    context.size >= AMD64_CONTEXT_SIZE
      ? named(view.u32(context.rva + AMD64_CONTEXT_FLAGS_OFFSET))
      : null
  return amd64 === CONTEXT_CPU_AMD64 ? amd64 : named(view.u32(context.rva))
}

function readSystemInfo(view: MinidumpView): { architecture: number; platformId: number } | null {
  const stream = findStream(view, STREAM_TYPE_SYSTEM_INFO)
  if (!stream) {
    return null
  }
  const architecture = view.u16(stream.rva + SYSTEM_INFO_ARCHITECTURE_OFFSET)
  const platformId = view.u32(stream.rva + SYSTEM_INFO_PLATFORM_ID_OFFSET)
  if (architecture === null || platformId === null) {
    return null
  }
  return { architecture, platformId }
}

type InstructionPointerRead =
  | { readonly value: bigint; readonly unreadable?: undefined }
  | { readonly value: null; readonly unreadable: string }

function readInstructionPointer(
  view: MinidumpView,
  exception: LocationDescriptor,
  architecture: number | undefined
): InstructionPointerRead {
  const layout =
    architecture === undefined ? undefined : INSTRUCTION_POINTER_LAYOUTS.get(architecture)
  if (!layout) {
    return {
      value: null,
      unreadable:
        architecture === undefined
          ? NO_SYSTEM_INFO
          : `this dump's CPU architecture (${architecture}) has no known thread context layout`
    }
  }
  const context = view.location(exception.rva + THREAD_CONTEXT_OFFSET)
  if (!context) {
    return { value: null, unreadable: NO_THREAD_CONTEXT }
  }
  if (context.size < layout.offset + layout.bytes) {
    return { value: null, unreadable: TRUNCATED_THREAD_CONTEXT }
  }
  // SYSTEM_INFO describes the machine; the context says what it actually is. On a
  // disagreement the pointer would be read out of the wrong struct and believed.
  const cpu = contextCpu(view, context)
  if (cpu !== null && !layout.cpus.includes(cpu)) {
    return { value: null, unreadable: CONTEXT_ARCHITECTURE_MISMATCH }
  }
  const at = context.rva + layout.offset
  const raw = layout.bytes === 4 ? view.u32(at) : view.u64(at)
  return raw === null
    ? { value: null, unreadable: TRUNCATED_THREAD_CONTEXT }
    : { value: BigInt(raw) }
}

/** `label` names what `address` actually is, since the fallback path has declined
 * to call it an instruction pointer. */
function locateModule(
  view: MinidumpView,
  address: bigint,
  label: 'instruction pointer' | 'exception address'
): FaultingModule {
  const list = readModules(view)
  if (!list) {
    return { unavailable: NO_MODULE_LIST }
  }
  if (list.modules.length === 0) {
    return { unavailable: list.complete ? NO_MODULES_LISTED : UNREADABLE_MODULE_LIST }
  }
  for (const module of list.modules) {
    if (address >= module.base && address < module.base + BigInt(module.size)) {
      return {
        name: moduleLabel(module),
        offset: `0x${(address - module.base).toString(16)}`
      }
    }
  }
  const at = `${label} 0x${address.toString(16)}`
  return {
    unavailable: list.complete
      ? `${at} is outside every loaded module`
      : `${at} is outside every module that could be read, and the dump's module list is truncated`
  }
}

/** Breakpad records the main executable with an empty name, and a name may end in
 * a separator; an empty label drops the whole line, reading as "no module". */
function moduleLabel(module: ModuleRecord): string {
  return (
    dumpPathBasename(module.name) ||
    module.name ||
    `unnamed module at 0x${module.base.toString(16)}`
  )
}

type DumpPlatform = 'posix' | 'windows' | 'unidentified'

function classifyPlatform(platformId: number | undefined): DumpPlatform {
  if (platformId === undefined) {
    return 'unidentified'
  }
  if (platformId >= PLATFORM_ID_POSIX_MIN) {
    return 'posix'
  }
  return platformId <= PLATFORM_ID_WINDOWS_MAX ? 'windows' : 'unidentified'
}

/**
 * Resolves the module covering the crashing instruction, or states why it
 * cannot be named. A module resolved from the exception address of a dump that
 * does not identify its OS carries `caveat`, because it may still be a POSIX
 * data address; callers must publish that alongside the name.
 */
export function resolveFaultingModule(
  view: MinidumpView,
  exception: LocationDescriptor,
  exceptionAddress: bigint | null
): FaultingModule {
  const systemInfo = readSystemInfo(view)
  const platform = classifyPlatform(systemInfo?.platformId)
  const read = readInstructionPointer(view, exception, systemInfo?.architecture)
  if (read.value !== null) {
    return locateModule(view, read.value, 'instruction pointer')
  }
  // Only a POSIX dump's exception address is certainly a data address; an
  // unknown platform keeps the attribution the parser used to make, caveated.
  if (platform === 'posix' || exceptionAddress === null) {
    return {
      unavailable:
        platform === 'posix' ? `${read.unreadable}; ${POSIX_ADDRESS_CAVEAT}` : read.unreadable
    }
  }
  const located = locateModule(view, exceptionAddress, 'exception address')
  if (located.unavailable !== undefined || platform === 'windows') {
    return located
  }
  return { ...located, caveat: UNIDENTIFIED_PLATFORM_CAVEAT }
}
