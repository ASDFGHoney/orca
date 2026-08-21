/** Single definition of the breadcrumb `origin` label so the recording side
 *  (IPC sender) and the reporting side (crash snapshot) agree on the format. */
export function rendererCrashBreadcrumbOrigin(webContentsId: number): string {
  return `renderer:${webContentsId}`
}
