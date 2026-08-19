const AUTO_GRANTED_BROWSER_PERMISSIONS = new Set([
  'fullscreen',
  // Agent-browser clipboard commands execute via CDP in this session; denying
  // them breaks trusted runtime commands even when invoked with a user gesture.
  'clipboard-read',
  'clipboard-sanitized-write',
  // User-opened browser pages need these profile-scoped grants to complete
  // normal site flows like web push setup and durable app storage.
  'notifications',
  // Chromium can request this at runtime even though Electron's TS union does
  // not list it; chatgpt.com uses it to keep browser storage from eviction.
  'persistent-storage',
  // Chromium still requires user activation, so this only removes Orca's
  // otherwise unactionable denial for immersive browser apps.
  'pointerLock',
  // This session allows unpartitioned third-party cookies, so a cross-site frame already reads and
  // writes them anyway; gating this protects nothing, and denying it consumed the caller's user
  // gesture. Electron builds neither Chrome's activation gate nor its auto-grant, so the embedder
  // must answer and check must agree with request. Revisit if Orca ever blocks third-party cookies.
  'storage-access'
])

// 'top-level-storage-access' is deliberately absent: Chromium gates requestStorageAccessFor() on
// Related Website Sets rather than cookie policy, and Orca has no such source, so the rationale
// above does not transfer to it.

export function isAutoGrantedBrowserSessionPermission(permission: string): boolean {
  return AUTO_GRANTED_BROWSER_PERMISSIONS.has(permission)
}
