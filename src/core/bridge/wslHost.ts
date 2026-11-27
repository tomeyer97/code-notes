// Inside WSL with its default (NAT) networking, Windows is not 127.0.0.1 but the guest's default gateway: a controller
// on Windows lists that address among its `urls`. It is still this computer, so the token may go there. Read from
// the kernel's route table (/proc/net/route); no vscode, no fs (unit-tested in test/bridgeDiscovery.test.ts).

/**
 * The default gateway in a /proc/net/route table, as a dotted IPv4 address; undefined when there is none. The table's
 * addresses are hex in the kernel's byte order (little-endian on every machine WSL runs on).
 */
export function defaultGateway(routeTable: string): string | undefined {
  for (const line of routeTable.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/)
    if (destination !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gateway ?? '') || gateway === '00000000') continue
    const bytes = gateway.match(/../g)!.map((b) => parseInt(b, 16))
    return bytes.reverse().join('.')
  }
  return undefined
}
