// Type-only, so this erases at compile time and creates no import cycle.
import type { CrashReportDetailValue } from './crash-reporting'
import { posixSignalName } from './posix-wait-status'

/** Only the NTSTATUS codes that change how the rest of the report should be read. */
const WINDOWS_EXCEPTION_CODE_NAMES: Record<string, string> = {
  '0x80000003': 'STATUS_BREAKPOINT',
  '0xc0000005': 'STATUS_ACCESS_VIOLATION',
  '0xc0000006': 'STATUS_IN_PAGE_ERROR',
  '0xc000001d': 'STATUS_ILLEGAL_INSTRUCTION',
  '0xc0000094': 'STATUS_INTEGER_DIVIDE_BY_ZERO',
  '0xc0000409': 'STATUS_STACK_BUFFER_OVERRUN',
  '0xc00000fd': 'STATUS_STACK_OVERFLOW',
  '0xe06d7363': 'C++ exception'
}

// <mach/exception_types.h>. Crashpad usually records EXC_CRASH for a fatal
// signal, so the type names the delivery mechanism, not the faulting operation.
const MACH_EXCEPTION_TYPE_NAMES: Record<number, string> = {
  1: 'EXC_BAD_ACCESS',
  2: 'EXC_BAD_INSTRUCTION',
  3: 'EXC_ARITHMETIC',
  4: 'EXC_EMULATION',
  5: 'EXC_SOFTWARE',
  6: 'EXC_BREAKPOINT',
  7: 'EXC_SYSCALL',
  8: 'EXC_MACH_SYSCALL',
  9: 'EXC_RPC_ALERT',
  10: 'EXC_CRASH',
  11: 'EXC_RESOURCE',
  12: 'EXC_GUARD',
  13: 'EXC_CORPSE_NOTIFY'
}

/**
 * Crashpad reuses one minidump field per platform: an NTSTATUS on Windows, the
 * Mach exception type on macOS, the POSIX signal everywhere else. Naming it off
 * the wrong table would be worse than the bare hex.
 */
function nameExceptionCode(code: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') {
    return WINDOWS_EXCEPTION_CODE_NAMES[code.toLowerCase()] ?? null
  }
  const value = Number.parseInt(code, 16)
  if (!Number.isInteger(value)) {
    return null
  }
  return platform === 'darwin' ? (MACH_EXCEPTION_TYPE_NAMES[value] ?? null) : posixSignalName(value)
}

// Wording stays platform-neutral: the image is `Orca.exe` on Windows, `orca` on
// Linux and `Electron Framework` on macOS.
const PRODUCT_IMAGE_CAVEAT =
  'Electron image with Chromium statically linked in, so the module name does not localize the fault; read the offset and exception code instead'

/**
 * Promotes the Crashpad-derived fields out of the details blob.
 *
 * Why: for a Chromium CHECK the exit code is only 0x80000003 (STATUS_BREAKPOINT),
 * so the fatal log line is the actual diagnosis and must not be buried in a
 * detail list the reader scrolls past.
 */
export function appendMinidumpSignatureLines(
  lines: string[],
  details: Record<string, CrashReportDetailValue>,
  platform: NodeJS.Platform
): void {
  if (typeof details.minidumpCheckMessage === 'string') {
    lines.push(`Check failure: ${details.minidumpCheckMessage}`)
  }
  const exceptionCode = details.minidumpExceptionCode
  if (typeof exceptionCode === 'string') {
    const name = nameExceptionCode(exceptionCode, platform)
    lines.push(`Exception: ${exceptionCode}${name ? ` (${name})` : ''}`)
  }
  if (typeof details.minidumpFaultingModule === 'string') {
    const offset = details.minidumpFaultingModuleOffset
    const suffix = typeof offset === 'string' ? `+${offset}` : ''
    // Older hosts send no kind; leaving those lines unqualified beats guessing.
    const caveat =
      details.minidumpFaultingModuleKind === 'product-image' ? ` (${PRODUCT_IMAGE_CAVEAT})` : ''
    lines.push(`Faulting module: ${details.minidumpFaultingModule}${suffix}${caveat}`)
  }
}
