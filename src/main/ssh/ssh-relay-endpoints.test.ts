import { describe, expect, it } from 'vitest'
import { relayEndpointForHost } from './ssh-relay-endpoints'
import { getRemoteHostPlatform } from './ssh-remote-platform'

describe('ssh-relay-endpoints', () => {
  describe('relayEndpointForHost', () => {
    it('returns the full path for a posix host if length <= 107', () => {
      const hostPlatform = getRemoteHostPlatform('linux-x64')
      const remoteDir = '/home/user/.orca-remote/relay'
      const sockName = 'relay.sock'
      const result = relayEndpointForHost(hostPlatform, remoteDir, sockName)
      expect(result).toBe('/home/user/.orca-remote/relay/relay.sock')
    })

    it('hashes the path and uses parent dir if length > 107 and parent dir fits', () => {
      const hostPlatform = getRemoteHostPlatform('linux-x64')
      // parent dir is 79 bytes. 79 + 30 (relay-v1.0.0/relay-12345.sock) = 109 > 107
      const remoteDir =
        '/home/a-seventy-nine-byte-long-path-up-to-here-that-fits-nicely-X/.orca-remote/relay-v1.0.0'
      const sockName = 'relay-12345.sock'
      const result = relayEndpointForHost(hostPlatform, remoteDir, sockName)
      expect(result).toMatch(
        /^\/home\/a-seventy-nine-byte-long-path-up-to-here-that-fits-nicely-X\/\.orca-remote\/[a-f0-9]{12}\.sock$/
      )
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(107)
    })

    it('falls back to /tmp if even the parent dir hashed path is too long (> 107)', () => {
      const hostPlatform = getRemoteHostPlatform('linux-x64')
      const remoteDir =
        '/home/extremely-long-user-name-that-is-so-long-it-completely-fills-the-entire-buffer-by-itself-and-leaves-no-room-for-parent-dir/.orca-remote/relay-v1.0.0'
      const sockName = 'relay.sock'
      const result = relayEndpointForHost(hostPlatform, remoteDir, sockName)
      expect(result).toMatch(/^\/tmp\/orca-[a-f0-9]{12}\.sock$/)
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(107)
    })

    it('returns windows named pipe format for windows host', () => {
      const hostPlatform = getRemoteHostPlatform('win32-x64')
      const remoteDir = 'C:/Users/user/.orca-remote/relay'
      const sockName = 'relay.sock'
      const result = relayEndpointForHost(hostPlatform, remoteDir, sockName)
      expect(result.startsWith('\\\\.\\pipe\\orca-relay-')).toBe(true)
    })
  })
})
