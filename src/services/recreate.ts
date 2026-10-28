// Rebuilds `container run` / `container create` arguments from a container's inspect configuration,
// with edited ports and mounts. Apple container cannot change these on an existing container, so editing
// means deleting the container and creating it again. No vscode dependency.
// Field layout follows ContainerConfiguration / ProcessConfiguration of apple/container 1.6.1.

import type { ContainerMount, PortMapping } from '../models/types';

type Json = Record<string, any>;

export interface ContainerEdits {
  ports: PortMapping[];
  mounts: ContainerMount[];
}

export interface RecreateOptions {
  /** `run --detach` for a running container, `create` for a stopped one */
  start: boolean;
  /** Image to create from; defaults to the container's own image (a snapshot when keeping changes) */
  image?: string;
}

export function formatPublishSpec(port: PortMapping): string {
  const host = port.hostAddress && port.hostAddress !== '0.0.0.0' ? `${port.hostAddress}:` : '';
  return `${host}${port.hostPort}:${port.containerPort}/${port.proto || 'tcp'}`;
}

export function mountArgs(mount: ContainerMount): string[] {
  if (mount.kind === 'tmpfs') {
    return ['--tmpfs', mount.destination];
  }
  return ['--volume', `${mount.source}:${mount.destination}${mount.readOnly ? ':ro' : ''}`];
}

/** RLIMIT_NOFILE -> nofile */
function ulimitName(limit: string): string {
  return limit.replace(/^RLIMIT_/i, '').toLowerCase();
}

export function buildRecreateArgs(config: Json, edits: ContainerEdits, options: RecreateOptions): string[] {
  const args: string[] = options.start ? ['run', '--detach'] : ['create'];
  args.push('--name', config.id);

  const init: Json = config.initProcess ?? {};
  for (const env of init.environment ?? []) {
    args.push('--env', env);
  }
  if (init.workingDirectory) {
    args.push('--workdir', init.workingDirectory);
  }
  const user: Json = init.user ?? {};
  if (user.raw?.userString) {
    args.push('--user', user.raw.userString);
  } else if (user.id && (user.id.uid !== 0 || user.id.gid !== 0)) {
    args.push('--uid', String(user.id.uid), '--gid', String(user.id.gid));
  }
  for (const limit of init.rlimits ?? []) {
    args.push('--ulimit', `${ulimitName(limit.limit)}=${limit.soft}:${limit.hard}`);
  }
  if (init.terminal) {
    args.push('--tty', '--interactive');
  }

  const resources: Json = config.resources ?? {};
  if (resources.cpus) {
    args.push('--cpus', String(resources.cpus));
  }
  if (resources.memoryInBytes) {
    // --memory has 1 MiB granularity
    args.push('--memory', `${Math.round(resources.memoryInBytes / 1024 / 1024)}M`);
  }

  for (const network of config.networks ?? []) {
    if (network.network) {
      args.push('--network', network.network);
    }
  }
  const dns: Json = config.dns;
  if (dns === null) {
    args.push('--no-dns');
  } else if (dns) {
    for (const ns of dns.nameservers ?? []) {
      args.push('--dns', ns);
    }
    if (dns.domain) {
      args.push('--dns-domain', dns.domain);
    }
    for (const search of dns.searchDomains ?? []) {
      args.push('--dns-search', search);
    }
    for (const option of dns.options ?? []) {
      args.push('--dns-option', option);
    }
  }
  for (const [key, value] of Object.entries<string>(config.labels ?? {})) {
    args.push('--label', `${key}=${value}`);
  }
  for (const cap of config.capAdd ?? []) {
    args.push('--cap-add', cap);
  }
  for (const cap of config.capDrop ?? []) {
    args.push('--cap-drop', cap);
  }
  const flags: [string, string][] = [
    ['readOnly', '--read-only'],
    ['rosetta', '--rosetta'],
    ['ssh', '--ssh'],
    ['useInit', '--init'],
    ['virtualization', '--virtualization'],
  ];
  for (const [key, flag] of flags) {
    if (config[key]) {
      args.push(flag);
    }
  }
  const platform: Json | undefined = config.platform;
  if (platform?.os && platform.architecture) {
    args.push('--platform', [platform.os, platform.architecture, platform.variant].filter(Boolean).join('/'));
  }
  for (const socket of config.publishedSockets ?? []) {
    const host = socket.hostPath?.path ?? socket.hostPath;
    const container = socket.containerPath?.path ?? socket.containerPath;
    if (typeof host === 'string' && typeof container === 'string') {
      args.push('--publish-socket', `${host}:${container}`);
    }
  }

  for (const port of edits.ports) {
    args.push('--publish', formatPublishSpec(port));
  }
  for (const mount of edits.mounts) {
    args.push(...mountArgs(mount));
  }

  // initProcess holds the resolved entrypoint + command, so pin both to keep the process identical
  if (init.executable) {
    args.push('--entrypoint', init.executable);
  }
  args.push(options.image ?? config.image?.reference);
  args.push(...(init.arguments ?? []));
  return args;
}

export type EditProblemReason =
  | 'portRange'
  | 'protocol'
  | 'duplicateHostPort'
  | 'relativeTarget'
  | 'relativeSource'
  | 'volumeName'
  | 'duplicateTarget';

export interface EditProblem {
  section: 'ports' | 'mounts';
  /** Zero-based row index */
  index: number;
  reason: EditProblemReason;
}

/** Returns the problems found; empty when the edits can be applied */
export function validateEdits(edits: ContainerEdits): EditProblem[] {
  const problems: EditProblem[] = [];
  const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  const seenHost = new Set<string>();
  edits.ports.forEach((p, index) => {
    const add = (reason: EditProblemReason) => problems.push({ section: 'ports', index, reason });
    if (!validPort(p.hostPort) || !validPort(p.containerPort)) {
      add('portRange');
    }
    if (p.proto !== 'tcp' && p.proto !== 'udp') {
      add('protocol');
    }
    const key = `${p.hostAddress || '0.0.0.0'}:${p.hostPort}/${p.proto}`;
    if (seenHost.has(key)) {
      add('duplicateHostPort');
    }
    seenHost.add(key);
  });
  const seenTarget = new Set<string>();
  edits.mounts.forEach((m, index) => {
    const add = (reason: EditProblemReason) => problems.push({ section: 'mounts', index, reason });
    if (!m.destination.startsWith('/')) {
      add('relativeTarget');
    }
    if (m.kind === 'bind' && !m.source.startsWith('/')) {
      add('relativeSource');
    }
    if (m.kind === 'volume' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(m.source)) {
      add('volumeName');
    }
    if (seenTarget.has(m.destination)) {
      add('duplicateTarget');
    }
    seenTarget.add(m.destination);
  });
  return problems;
}

/** Messages exchanged with the edit webview (src/webview/edit.ts) */
export type EditToWebview =
  | { type: 'init'; id: string; image: string; running: boolean; ports: PortMapping[]; mounts: ContainerMount[]; volumes: string[] }
  | { type: 'browsed'; index: number; path: string }
  | { type: 'problems'; messages: string[] }
  | { type: 'busy'; busy: boolean };

export type EditFromWebview =
  | { type: 'ready' }
  | { type: 'browse'; index: number }
  | { type: 'save'; edits: ContainerEdits }
  | { type: 'cancel' };
