// Registry helpers for image references; free of the vscode API for unit tests

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Registry host of a reference, e.g. localhost:5000 for localhost:5000/app:1; Docker Hub references have none */
export function registryHost(reference: string): string | undefined {
  const slash = reference.indexOf('/');
  if (slash < 0) {
    return undefined;
  }
  const first = reference.slice(0, slash);
  // Same rule as Docker: the first component is a host only if it looks like one
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : undefined;
}

function hostWithoutPort(host: string): string {
  if (host.startsWith('[')) {
    return host.slice(0, host.indexOf(']') + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon > 0 ? host.slice(0, colon) : host;
}

/**
 * The CLI talks https unless told otherwise. Loopback registries are treated as insecure like Docker does,
 * others only when listed (host or host:port) in appleContainer.insecureRegistries.
 */
export function schemeArgs(reference: string, insecureRegistries: readonly string[] = []): string[] {
  const host = registryHost(reference);
  if (!host) {
    return [];
  }
  const insecure =
    LOOPBACK_HOSTS.has(hostWithoutPort(host)) ||
    insecureRegistries.some((entry) => entry === host || entry === hostWithoutPort(host));
  return insecure ? ['--scheme', 'http'] : [];
}

/** File name for an image archive, e.g. ghcr.io/org/app:1.0 -> app_1.0.tar */
export function archiveFileName(references: readonly string[]): string {
  if (references.length !== 1) {
    return 'images.tar';
  }
  const last = references[0].split('/').pop() ?? references[0];
  return `${last.replace(/[^A-Za-z0-9._-]/g, '_')}.tar`;
}
