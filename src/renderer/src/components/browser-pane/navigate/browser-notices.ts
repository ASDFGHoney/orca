import type {
  BrowserDownloadFinishedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../../../../shared/browser-guest-events'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { isChromiumCertificateErrorCode } from '../../../../../shared/browser-certificate-errors'
import { translate } from '@/i18n/i18n'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'

export type LoadFailureMeta = {
  host: string | null
  isLocalhostLike: boolean
}

type BrowserLoadErrorLike = BrowserLoadError | null

// Why: the raw Chromium permission name is what the user sees in the denial notice, and most of
// them do not read as English - "top-level-storage-access" is the one users hit most now that
// ordinary storage-access is granted. The default still returns the raw token, because inventing
// prose for a permission nobody has seen yet is worse than showing its real name.
function humanizePermission(permission: string): string {
  switch (permission) {
    case 'media':
      return 'camera or microphone access'
    case 'pointerLock':
      return 'pointer lock'
    case 'storage-access':
    case 'top-level-storage-access':
      return 'access to its own cookies and storage on this site'
    case 'geolocation':
      return 'your location'
    case 'idle-detection':
      return 'to detect when you are idle'
    case 'display-capture':
      return 'to capture your screen'
    case 'window-management':
      return 'to manage windows on your screen'
    case 'keyboardLock':
      return 'to capture all keyboard input'
    case 'openExternal':
      return 'to open an external app'
    case 'fileSystem':
      return 'access to your files'
    case 'hid':
      return 'access to a USB input device'
    case 'usb':
      return 'access to a USB device'
    case 'serial':
      return 'access to a serial device'
    case 'midi':
    case 'midiSysex':
      return 'access to your MIDI devices'
    case 'speaker-selection':
      return 'to choose an audio output device'
    default:
      return permission
  }
}

export function formatPermissionNotice(event: BrowserPermissionDeniedEvent): string {
  const target = event.origin === 'unknown' ? 'this page' : event.origin
  return `${target} asked for ${humanizePermission(event.permission)}, and Orca denied it.`
}

export function formatPopupNotice(event: BrowserPopupEvent): string {
  const target = event.origin === 'unknown' ? 'A site' : event.origin
  if (event.action === 'opened-in-orca') {
    return `${target} opened a new page in Orca.`
  }
  if (event.action === 'opened-external') {
    return `${target} opened a new window in your default browser.`
  }
  return `${target} tried to open a popup Orca does not support here.`
}

export function formatDownloadFinishedNotice(event: BrowserDownloadFinishedEvent): string {
  if (event.status === 'completed') {
    return event.savePath ? `Downloaded to ${event.savePath}.` : 'Download complete.'
  }
  if (event.status === 'failed') {
    return event.error ?? 'Download failed.'
  }
  return event.error ?? 'Download canceled.'
}

export function formatByteCount(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return null
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

export function formatLoadFailureDescription(
  loadError: BrowserLoadErrorLike,
  meta: LoadFailureMeta
): string {
  if (!loadError) {
    return 'The page did not respond.'
  }
  if (loadError.code === BROWSER_GUEST_RECOVERY_ERROR_CODE) {
    return loadError.description
  }
  if (isChromiumCertificateErrorCode(loadError.code)) {
    const host = meta.host ?? 'this address'
    if (loadError.code === -200) {
      return translate(
        'browser.loadFailure.certificateNameMismatch',
        "The certificate doesn't match {{value0}}.",
        { value0: host }
      )
    }
    if (loadError.code === -201) {
      return translate(
        'browser.loadFailure.certificateDateInvalid',
        "The certificate for {{value0}} isn't valid at the current date and time.",
        { value0: host }
      )
    }
    if (loadError.code === -202) {
      return translate(
        'browser.loadFailure.certificateAuthorityInvalid',
        "Orca doesn't trust the authority that issued the certificate for {{value0}}.",
        { value0: host }
      )
    }
    return translate(
      'browser.loadFailure.certificateVerificationFailed',
      "Orca couldn't verify the certificate for {{value0}}.",
      { value0: host }
    )
  }
  if (meta.isLocalhostLike) {
    return "We couldn't connect to your local server."
  }
  if (loadError.code === 0) {
    return loadError.description
  }
  return "We couldn't connect to this page."
}

export function formatLoadFailureRecoveryHint(
  meta: LoadFailureMeta,
  loadError?: BrowserLoadErrorLike
): string | null {
  if (
    !meta.isLocalhostLike ||
    loadError?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE ||
    (loadError && isChromiumCertificateErrorCode(loadError.code))
  ) {
    return null
  }
  return 'If this should be a local app, make sure the server is running and listening on the expected port.'
}

export function isCertificateLoadError(loadError: BrowserLoadErrorLike): boolean {
  return Boolean(loadError && isChromiumCertificateErrorCode(loadError.code))
}
