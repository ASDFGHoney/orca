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
  // writes them at the network layer. Gating storage-access therefore grants no protection and only
  // breaks sites that take the API's failure path. Chrome resolves requestStorageAccess() without a
  // prompt under the same cookie policy; Electron has no such fast path and forwards the request to
  // the embedder, so the embedder supplies it. Revisit if Orca ever blocks third-party cookies.
  'storage-access'
  // 'top-level-storage-access' is deliberately ABSENT. requestStorageAccessFor() is a different
  // platform decision: Chromium requires a primary main frame plus transient activation and then
  // consults Related Website Sets, granting only a non-service member of the same set. It has no
  // "third-party cookies already allowed" auto-grant, so the rationale above does not transfer, and
  // Orca has no Related Website Sets source to reproduce the rule. Denying is the honest answer.
])

export function isAutoGrantedBrowserSessionPermission(permission: string): boolean {
  return AUTO_GRANTED_BROWSER_PERMISSIONS.has(permission)
}
