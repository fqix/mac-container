// Parses container CLI JSON output into the extension model. Depends only on types.ts so it can be unit tested.
// Field layout follows the actual output of container CLI 1.6.1, see test/fixtures.

import type {
  ContainerMount,
  ContainerStats,
  ContainerSummary,
  ImageSummary,
  NetworkSummary,
  PortMapping,
  RegistrySummary,
  SystemStatus,
  VolumeSummary,
} from '../models/types';

type Json = Record<string, any>;

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  return JSON.parse(trimmed);
}

/** docker.io/library/alpine:latest -> alpine:latest; other registries keep the full prefix */
export function shortImageName(reference: string): string {
  for (const prefix of ['docker.io/library/', 'docker.io/']) {
    if (reference.startsWith(prefix)) {
      return reference.slice(prefix.length);
    }
  }
  return reference;
}

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

function parsePort(port: Json): PortMapping {
  return {
    hostAddress: port.hostAddress ?? port.hostIP ?? '0.0.0.0',
    hostPort: Number(port.hostPort),
    containerPort: Number(port.containerPort),
    proto: port.proto ?? port.protocol ?? 'tcp',
  };
}

export function formatPort(port: PortMapping): string {
  const host = port.hostAddress && port.hostAddress !== '0.0.0.0' ? `${port.hostAddress}:${port.hostPort}` : `${port.hostPort}`;
  return `${host}->${port.containerPort}/${port.proto}`;
}

/** mount.type is an enum encoded as a single-key object, e.g. {"volume": {...}} or {"virtiofs": {}} */
function parseMount(mount: Json): ContainerMount {
  const type: Json = mount.type ?? {};
  const options: string[] = Array.isArray(mount.options) ? mount.options : [];
  const readOnly = options.includes('ro');
  if (type.volume) {
    return { kind: 'volume', source: type.volume.name ?? mount.source, destination: mount.destination, readOnly };
  }
  if (type.virtiofs) {
    return { kind: 'bind', source: mount.source, destination: mount.destination, readOnly };
  }
  return { kind: Object.keys(type)[0] ?? 'unknown', source: mount.source ?? '', destination: mount.destination, readOnly };
}

/** initProcess.user is either {raw: {userString}} or {id: {uid, gid}} */
function parseUser(user: Json | undefined): string | undefined {
  if (typeof user?.raw?.userString === 'string' && user.raw.userString) {
    return user.raw.userString;
  }
  return typeof user?.id?.uid === 'number' ? String(user.id.uid) : undefined;
}

export function parseContainers(data: unknown): ContainerSummary[] {
  return asArray(data).map((item) => {
    const config: Json = item.configuration ?? {};
    const status: Json = item.status ?? {};
    const init: Json = config.initProcess ?? {};
    const command = [init.executable, ...(init.arguments ?? [])].filter(Boolean).join(' ');
    const statusNetworks = asArray(status.networks);
    const ipv4 = statusNetworks.find((n) => n.ipv4Address)?.ipv4Address as string | undefined;
    const platform: Json | undefined = config.platform;
    const labels: Json = config.labels ?? {};
    const publishedPorts = asArray(config.publishedPorts).map(parsePort);
    return {
      id: item.id ?? config.id,
      image: config.image?.reference ?? '',
      state: status.state ?? 'unknown',
      command,
      createdAt: config.creationDate,
      startedAt: status.startedDate,
      ipv4: ipv4?.split('/')[0],
      networks: asArray(config.networks).map((n) => n.network).filter(Boolean),
      ports: publishedPorts.map(formatPort),
      publishedPorts,
      mounts: asArray(config.mounts).map(parseMount),
      composeProject: labels[COMPOSE_PROJECT_LABEL],
      composeService: labels[COMPOSE_SERVICE_LABEL],
      cpus: config.resources?.cpus,
      memoryBytes: config.resources?.memoryInBytes,
      platform: platform ? [platform.os, platform.architecture, platform.variant].filter(Boolean).join('/') : undefined,
      user: parseUser(init.user),
      workdir: typeof init.workingDirectory === 'string' && init.workingDirectory ? init.workingDirectory : undefined,
    };
  });
}

export function parseImages(data: unknown): ImageSummary[] {
  return asArray(data).map((item) => {
    const config: Json = item.configuration ?? {};
    const variants = asArray(item.variants);
    const reference: string = config.name ?? item.id;
    return {
      reference,
      displayName: shortImageName(reference),
      digest: config.descriptor?.digest ?? item.id ?? '',
      createdAt: config.creationDate,
      sizeBytes: variants.reduce((sum, v) => sum + (typeof v.size === 'number' ? v.size : 0), 0),
      platforms: variants
        .map((v) => v.platform)
        .filter(Boolean)
        .map((p: Json) => [p.os, p.architecture, p.variant].filter(Boolean).join('/')),
    };
  });
}

export function parseNetworks(data: unknown): NetworkSummary[] {
  return asArray(data).map((item) => {
    const config: Json = item.configuration ?? {};
    const status: Json = item.status ?? {};
    return {
      id: item.id ?? config.name,
      mode: config.mode,
      ipv4Subnet: status.ipv4Subnet,
      ipv4Gateway: status.ipv4Gateway,
      ipv6Subnet: status.ipv6Subnet,
      builtin: config.labels?.['com.apple.container.resource.role'] === 'builtin',
    };
  });
}

export function parseVolumes(data: unknown): VolumeSummary[] {
  return asArray(data).map((item) => {
    const config: Json = item.configuration ?? {};
    return {
      name: config.name ?? item.id,
      driver: config.driver,
      format: config.format,
      sizeBytes: config.sizeInBytes,
      source: config.source,
      createdAt: config.creationDate,
    };
  });
}

/** Foundation dates are ISO 8601 strings in CLI output; numbers are seconds since 2001-01-01 (Swift's default encoding) */
function toIsoDate(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return new Date((value + 978_307_200) * 1000).toISOString();
  }
  return undefined;
}

export function parseRegistries(data: unknown): RegistrySummary[] {
  return asArray(data).map((item) => ({
    hostname: item.name ?? item.id ?? item.hostname,
    username: item.username ?? '',
    createdAt: toIsoDate(item.creationDate),
    modifiedAt: toIsoDate(item.modificationDate),
  }));
}

export function parseSystemStatus(data: unknown): SystemStatus {
  const item = (data ?? {}) as Json;
  return {
    running: item.status === 'running',
    clientVersion: item.client?.version,
    serverVersion: item.server?.version,
    containersRunning: item.resources?.containersRunning,
    containersTotal: item.resources?.containersTotal,
    images: item.resources?.images,
  };
}

export function parseStats(data: unknown): ContainerStats[] {
  return asArray(data).map((item) => ({ ...item, id: item.id }) as ContainerStats);
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Formats a relative time such as "3 minutes ago" for the locale; translations come from Intl */
export function formatRelativeTime(iso: string | undefined, locale = 'en', now: Date = new Date()): string {
  if (!iso) {
    return '';
  }
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const seconds = Math.round((time - now.getTime()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Infinity],
  ];
  let value = Math.min(0, seconds);
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) {
      return rtf.format(value, unit);
    }
    value = Math.trunc(value / size);
  }
  return '';
}
