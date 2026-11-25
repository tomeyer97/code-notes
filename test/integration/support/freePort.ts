// A TCP port nobody listens on, for VS Code's DevTools (--remote-debugging-port). The system picks it (port 0), so two
// runs on one machine, or a VS Code left over from an earlier run, don't collide.
import * as net from 'net'

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}
