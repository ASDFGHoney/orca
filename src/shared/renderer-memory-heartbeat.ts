/**
 * The renderer's periodic memory sample doubles as a liveness heartbeat: the
 * gap between the last one and a crash report measures how long the renderer
 * had been silent before it died. Shared so main reads the cadence it is
 * measuring against instead of hardcoding a copy of the renderer's interval.
 */
export const RENDERER_MEMORY_HEARTBEAT_BREADCRUMB = 'renderer_memory'
export const RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS = 60_000
