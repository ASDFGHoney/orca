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
  // Orca allows unpartitioned third-party cookies, so cross-site frames already send them; denying
  // this only rejected the API and consumed the caller's user gesture. Not cookies-only, though:
  // the same permission also lifts third-party partitioning for localStorage/IndexedDB, which
  // Chrome equally grants under this cookie policy. Electron has no auto-grant, so the embedder
  // must answer, and check must agree with request. Revisit if Orca ever gains a cookie or
  // storage-partitioning control.
  'storage-access'
])

// 'top-level-storage-access' is deliberately absent: Chromium gates requestStorageAccessFor() on
// Related Website Sets rather than cookie policy, and Orca has no such source, so the rationale
// above does not transfer to it.

export function isAutoGrantedBrowserSessionPermission(permission: string): boolean {
  return AUTO_GRANTED_BROWSER_PERMISSIONS.has(permission)
}
