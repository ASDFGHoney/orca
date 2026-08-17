import { createServer, type Server, Socket } from 'node:net'

export function createBrowserRouteTcpEgressSocksRecorder(
  allowedPorts: Set<number>,
  routedSourcePorts: Set<number>,
  hosts: Set<string>,
  sockets: Set<Socket>
): Server {
  return createServer((client) => {
    trackSocket(client, sockets)
    let buffer = Buffer.alloc(0)
    let greeted = false
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (!greeted) {
        const greetingLength = buffer.length >= 2 ? 2 + (buffer[1] ?? 0) : Infinity
        if (buffer.length < greetingLength) {
          return
        }
        buffer = buffer.subarray(greetingLength)
        greeted = true
        client.write(Buffer.from([5, 0]))
      }
      const request = parseSocksRequest(buffer)
      if (!request) {
        return
      }
      client.off('data', onData)
      hosts.add(request.host)
      if (!allowedPorts.has(request.port)) {
        client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))
        return
      }
      connectSocksUpstream(client, request.port, request.remainder, routedSourcePorts, sockets)
    }
    client.on('data', onData)
  })
}

function parseSocksRequest(
  buffer: Buffer
): { host: string; port: number; remainder: Buffer } | null {
  if (buffer.length < 5) {
    return null
  }
  const type = buffer[3]
  const addressLength = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? (buffer[4] ?? 0) + 1 : 0
  const requestLength = 4 + addressLength + 2
  if (addressLength === 0 || buffer.length < requestLength) {
    return null
  }
  const host =
    type === 3
      ? buffer.subarray(5, 5 + (buffer[4] ?? 0)).toString('utf8')
      : type === 1
        ? [...buffer.subarray(4, 8)].join('.')
        : 'ipv6'
  return {
    host,
    port: buffer.readUInt16BE(requestLength - 2),
    remainder: buffer.subarray(requestLength)
  }
}

function connectSocksUpstream(
  client: Socket,
  port: number,
  remainder: Buffer,
  routedSourcePorts: Set<number>,
  sockets: Set<Socket>
): void {
  const upstream = new Socket()
  trackSocket(upstream, sockets)
  upstream.connect(port, '127.0.0.1', () => {
    routedSourcePorts.add(upstream.localPort ?? -1)
    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
    if (remainder.length > 0) {
      upstream.write(remainder)
    }
    client.pipe(upstream).pipe(client)
  })
  upstream.on('error', () => client.destroy())
  client.on('error', () => upstream.destroy())
  client.once('close', () => upstream.destroy())
}

function trackSocket(socket: Socket, sockets: Set<Socket>): void {
  sockets.add(socket)
  socket.on('error', () => socket.destroy())
  socket.once('close', () => sockets.delete(socket))
}
