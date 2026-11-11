// Listening TCP ports of a container, read from /proc/net/tcp and /proc/net/tcp6 so the image needs no ss or netstat.
// Every Apple container VM has its own IP that this Mac can reach, so such a port works without --publish.

/** Shell command that prints both tables; tcp6 is missing when IPv6 is disabled, which is not an error */
export const LISTENING_PORTS_SCRIPT =
  'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; exit 0';

export interface ListeningPort {
  port: number;
  /** Local addresses it listens on, e.g. 0.0.0.0, ::, 127.0.0.1 */
  addresses: string[];
  /** False when it only listens on a loopback address, so it cannot be reached from the Mac */
  reachable: boolean;
}

/** TCP_LISTEN in the kernel's tcp_states.h */
const LISTEN = '0A';

/** /proc/net/tcp stores each 32-bit word of an address in host (little-endian) byte order */
function wordBytes(hex: string): number[] {
  return [6, 4, 2, 0].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function decodeAddress(hex: string): string | undefined {
  if (hex.length === 8) {
    return wordBytes(hex).join('.');
  }
  if (hex.length !== 32) {
    return undefined;
  }
  const bytes = [0, 8, 16, 24].flatMap(i => wordBytes(hex.slice(i, i + 8)));
  // ::ffff:a.b.c.d
  if (
    bytes.slice(0, 10).every(b => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  // Compress the longest run of zero groups, as in RFC 5952
  let best = {start: -1, length: 0};
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && groups[j] === '0') {
      j++;
    }
    if (j - i > best.length && j - i > 1) {
      best = {start: i, length: j - i};
    }
    i = j === i ? i + 1 : j;
  }
  if (best.start < 0) {
    return groups.join(':');
  }
  const head = groups.slice(0, best.start).join(':');
  const tail = groups.slice(best.start + best.length).join(':');
  return `${head}::${tail}`;
}

function isLoopback(address: string): boolean {
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

/** Listening ports from the concatenated /proc/net/tcp and /proc/net/tcp6 tables, sorted by port */
export function parseListeningPorts(text: string): ListeningPort[] {
  const byPort = new Map<number, Set<string>>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    // sl local_address rem_address st ...; header lines have "local_address" in that column
    if (fields.length < 4 || fields[3] !== LISTEN) {
      continue;
    }
    const [hexAddress, hexPort] = fields[1].split(':');
    const address = hexAddress && decodeAddress(hexAddress);
    const port = parseInt(hexPort ?? '', 16);
    if (!address || !Number.isInteger(port) || port <= 0) {
      continue;
    }
    if (!byPort.has(port)) {
      byPort.set(port, new Set());
    }
    byPort.get(port)!.add(address);
  }
  return [...byPort.entries()]
    .sort(([a], [b]) => a - b)
    .map(([port, set]) => {
      const addresses = [...set].sort();
      return {port, addresses, reachable: addresses.some(a => !isLoopback(a))};
    });
}

/** URL of a listening port through the container's own IP address */
export function containerPortUrl(ipv4: string, port: number): string {
  return `http://${ipv4}:${port}`;
}
