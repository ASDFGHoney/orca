import { BrowserWindow, type Cookie, type Session } from 'electron'
import { sendCookieDebuggerCommand } from './browser-cookie-debugger-command'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { normalizeCookieDomain } from './browser-cookie-import-policy'
import type {
  CookieClearIdentity,
  CookieClearPartitionKey,
  CookieClearStore,
  CookieImportWriteStore
} from './browser-cookie-import-clear'
import { restoreEveryCookieIdentity } from './browser-cookie-identity-restore'
import { normalizeCookiePartitionSite } from './browser-cookie-source-partition'

type CdpCookiePartitionKey = {
  topLevelSite?: string
  hasCrossSiteAncestor?: boolean
}

type CdpCookie = {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expires?: number
  sameSite?: string
  partitionKey?: CdpCookiePartitionKey | null
  partitionKeyOpaque?: boolean
}

type CookieClearDebugger = {
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

type CookieClearSession = {
  debugger: CookieClearDebugger
  dispose: () => void
}

function cdpSameSite(sameSite: Cookie['sameSite']): 'Strict' | 'Lax' | 'None' | undefined {
  if (sameSite === 'strict') {
    return 'Strict'
  }
  if (sameSite === 'no_restriction') {
    return 'None'
  }
  return sameSite === 'lax' ? 'Lax' : undefined
}

function electronSameSite(sameSite: string | undefined): Cookie['sameSite'] {
  if (sameSite === 'Strict' || sameSite === 'None') {
    return sameSite === 'Strict' ? 'strict' : 'no_restriction'
  }
  return sameSite === 'Lax' ? 'lax' : 'unspecified'
}

function partitionKeyFromCdp(cookie: CdpCookie): CookieClearPartitionKey | undefined {
  const opaque = cookie.partitionKeyOpaque
  if (opaque === true || (opaque !== undefined && typeof opaque !== 'boolean')) {
    throw new Error('Could not snapshot cookie identity for an atomic clear')
  }
  const partitionKey = cookie.partitionKey
  if (partitionKey === undefined) {
    return undefined
  }
  const topLevelSite = normalizeCookiePartitionSite(partitionKey?.topLevelSite ?? '')
  if (!topLevelSite || typeof partitionKey?.hasCrossSiteAncestor !== 'boolean') {
    throw new Error('Could not snapshot cookie identity for an atomic clear')
  }
  return {
    topLevelSite,
    hasCrossSiteAncestor: partitionKey.hasCrossSiteAncestor
  }
}

function cookieScopeKey(
  name: string,
  domain: string | undefined,
  path: string | undefined,
  hostOnly: boolean
): string | null {
  const normalizedDomain = domain ? normalizeCookieDomain(domain) : null
  return normalizedDomain ? JSON.stringify([name, normalizedDomain, path || '/', hostOnly]) : null
}

function cdpCookieScopeKey(cookie: CdpCookie): string | null {
  return cookieScopeKey(cookie.name, cookie.domain, cookie.path, !cookie.domain?.startsWith('.'))
}

function indexCdpCookies(cookies: readonly CdpCookie[]): Map<string, CdpCookie[]> {
  const index = new Map<string, CdpCookie[]>()
  for (const cookie of cookies) {
    const key = cdpCookieScopeKey(cookie)
    if (!key) {
      continue
    }
    const matches = index.get(key) ?? []
    matches.push(cookie)
    index.set(key, matches)
  }
  return index
}

function identityFromCdpCookie(url: string, cdpCookie: CdpCookie): CookieClearIdentity {
  const partitionKey = partitionKeyFromCdp(cdpCookie)
  return {
    url,
    name: cdpCookie.name,
    value: cdpCookie.value,
    domain: cdpCookie.domain,
    hostOnly: !cdpCookie.domain?.startsWith('.'),
    path: cdpCookie.path,
    secure: cdpCookie.secure,
    httpOnly: cdpCookie.httpOnly,
    sameSite: electronSameSite(cdpCookie.sameSite),
    ...(cdpCookie.session === true || cdpCookie.expires == null
      ? {}
      : { expirationDate: cdpCookie.expires }),
    ...(partitionKey ? { partitionKey } : {})
  }
}

function openHiddenCookieWindow(targetSession: Session): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      session: targetSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
}

async function leaseHiddenCookieDebugger(targetSession: Session): Promise<CookieClearSession> {
  const window = openHiddenCookieWindow(targetSession)
  try {
    await window.loadURL('data:text/html,<!doctype html><title>cookie-clear</title>')
    const contents = window.webContents
    if (contents.isDestroyed()) {
      throw new Error('Could not attach to the cookie session for an atomic clear')
    }
    const lease = acquireElectronDebugger(contents)
    let disposed = false
    return {
      debugger: contents.debugger,
      dispose: () => {
        if (disposed) {
          return
        }
        disposed = true
        try {
          lease.release()
        } finally {
          if (!contents.isDestroyed()) {
            window.destroy()
          }
        }
      }
    }
  } catch (error) {
    window.destroy()
    throw error
  }
}

export function cookieClearIdentitiesFromCdp(
  cookies: readonly { cookie: Cookie; url: string }[],
  cdpCookies: readonly CdpCookie[]
): CookieClearIdentity[] {
  const identities: CookieClearIdentity[] = []
  const seen = new Set<string>()
  const cdpCookieIndex = indexCdpCookies(cdpCookies)
  for (const item of cookies) {
    const key = cookieScopeKey(
      item.cookie.name,
      item.cookie.domain,
      item.cookie.path,
      item.cookie.hostOnly ?? !item.cookie.domain?.startsWith('.')
    )
    const matches = key ? (cdpCookieIndex.get(key) ?? []) : []
    if (matches.length === 0) {
      throw new Error('Could not snapshot cookie identity for an atomic clear')
    }
    for (const match of matches) {
      const key = JSON.stringify([
        item.url,
        match.name,
        match.domain,
        match.path,
        partitionKeyFromCdp(match) ?? null
      ])
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      identities.push(identityFromCdpCookie(item.url, match))
    }
  }
  return identities
}

export function cdpSetCookieParamsFromIdentity(
  identity: CookieClearIdentity
): Record<string, unknown> {
  const sameSite = cdpSameSite(identity.sameSite)
  return {
    url: identity.url,
    name: identity.name,
    value: identity.value,
    ...(identity.hostOnly ? {} : { domain: identity.domain }),
    ...(identity.path ? { path: identity.path } : {}),
    secure: identity.secure,
    httpOnly: identity.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(identity.expirationDate ? { expires: identity.expirationDate } : {}),
    ...(identity.partitionKey ? { partitionKey: identity.partitionKey } : {})
  }
}

function cdpCookiesFromCommand(value: unknown): CdpCookie[] {
  if (typeof value !== 'object' || value === null || !('cookies' in value)) {
    return []
  }
  const cookies = value.cookies
  return Array.isArray(cookies) ? cookies : []
}

function cdpSetCookieSucceeded(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('success' in value)) {
    return true
  }
  return value.success !== false
}

async function snapshotClearIdentitiesFromCdp(
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  cookies: readonly { cookie: Cookie; url: string }[]
): Promise<CookieClearIdentity[]> {
  const result = await sendCommand('Network.getAllCookies')
  return cookieClearIdentitiesFromCdp(cookies, cdpCookiesFromCommand(result))
}

async function writeIdentityWithCdp(
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  identity: CookieClearIdentity,
  failureLabel: string
): Promise<void> {
  const result = await sendCommand('Network.setCookie', cdpSetCookieParamsFromIdentity(identity))
  // Why: Network.setCookie reports rejection in the reply rather than throwing, so an unchecked
  // call reads as a successful write of a cookie that was never stored.
  if (!cdpSetCookieSucceeded(result)) {
    throw new Error(`Could not ${failureLabel} cookie ${identity.name}`)
  }
}

export function openCookieClearStore(
  targetSession: Session
): CookieClearStore & CookieImportWriteStore & { dispose: () => void } {
  let attached: CookieClearSession | null = null
  let pendingAttach: Promise<CookieClearSession> | null = null
  let disposed = false
  const retire = (session: CookieClearSession) => {
    if (attached === session) {
      attached = null
    }
    session.dispose()
  }
  const attach = async () => {
    if (disposed) {
      throw new Error('Cookie clear store was disposed')
    }
    if (attached) {
      return attached
    }
    if (pendingAttach) {
      return pendingAttach
    }
    const pending = leaseHiddenCookieDebugger(targetSession).then((session) => {
      if (disposed) {
        session.dispose()
        throw new Error('Cookie clear store was disposed during debugger attachment')
      }
      attached = session
      return session
    })
    pendingAttach = pending
    try {
      return await pending
    } finally {
      if (pendingAttach === pending) {
        pendingAttach = null
      }
    }
  }
  const sendCommand = async (method: string, params?: Record<string, unknown>) => {
    const session = await attach()
    return sendCookieDebuggerCommand(session, method, params, () => retire(session))
  }
  return {
    get: (filter) => targetSession.cookies.get(filter),
    remove: (url, name) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: async (cookies) =>
      snapshotClearIdentitiesFromCdp(sendCommand, cookies),
    restoreClearIdentities: async (identities) => {
      await attach()
      await restoreEveryCookieIdentity(identities, (identity) =>
        writeIdentityWithCdp(sendCommand, identity, 'restore')
      )
    },
    writeCookieIdentity: async (identity) => writeIdentityWithCdp(sendCommand, identity, 'import'),
    dispose: () => {
      disposed = true
      pendingAttach = null
      attached?.dispose()
      attached = null
    }
  }
}
