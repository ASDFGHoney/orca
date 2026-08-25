/**
 * The renderer's own OS-level footprint, which no V8 or Blink counter reports.
 *
 * Why this exists: `renderer_memory` breadcrumbs have been reporting a ~150MB V8
 * heap on renderers whose process private footprint was 600MB+ (Windows crash
 * 36048e26). Neither number is wrong — xterm scrollback lives in `Uint32Array`
 * backing stores, which V8 counts as external memory, and glyph atlases live in
 * GPU transfer buffers. Both sit outside `usedHeapSize`, `mallocedMemory`, and
 * Blink's allocator, so the JS-heap ratio that arms the memory-highwater
 * breadcrumb never trips and the report arrives with no attribution at all.
 *
 * Electron reports these in kilobytes; we keep that unit unconverted here.
 */
export type RendererProcessMemory = {
  /** Not shared with any other process — the number Windows Task Manager shows. */
  privateKB: number
  /** Absent on platforms where Chromium does not report a resident set. */
  residentKB?: number
}
