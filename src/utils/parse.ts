// Parses container CLI JSON output into the extension model. Depends only on types.ts so it can be unit tested.
// Field layout follows the actual output of container CLI 1.6.1, see test/fixtures; 1.7.1 only adds cpuUtilization
// to the stats output.

import type {
  ClusterNode,
  ClusterSummary,
  ContainerMount,
  ContainerStats,
  ContainerSummary,
  DiskUsage,
  DiskUsageEntry,
  ImageSummary,
  MachineDetails,
  MachineSummary,
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

/**
 * Splits a short image name into repository and tag: `ubuntu:22.04` -> `ubuntu` / `22.04`. A digest reference keeps
 * a shortened digest as its tag (`@sha256:ce977ae6d659`); a colon before the last slash is a registry port.
 */
export function splitImageName(name: string): {
  repository: string;
  tag: string;
} {
  const at = name.indexOf('@');
  const named = at >= 0 ? name.slice(0, at) : name;
  const colon = named.lastIndexOf(':');
  const tagged = colon > named.lastIndexOf('/');
  const repository = tagged ? named.slice(0, colon) : named;
  if (at >= 0) {
    return {
      repository,
      tag: name.slice(at, at + 1 + 'sha256:'.length + 12),
    };
  }
  return {repository, tag: tagged ? named.slice(colon + 1) : 'latest'};
}

export interface ImageRepository {
  name: string;
  images: ImageSummary[];
}

/** Groups images by repository like `docker images`, both sorted by name */
export function groupImagesByRepository(
  images: ImageSummary[],
): ImageRepository[] {
  const groups = new Map<string, ImageSummary[]>();
  for (const image of images) {
    const {repository} = splitImageName(image.displayName);
    groups.set(repository, [...(groups.get(repository) ?? []), image]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({
      name,
      images: list.sort((a, b) =>
        splitImageName(a.displayName).tag.localeCompare(
          splitImageName(b.displayName).tag,
        ),
      ),
    }));
}

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
/** Set by Apple container on resources it manages: builtin for the default network, builder for the BuildKit container */
const RESOURCE_ROLE_LABEL = 'com.apple.container.resource.role';

function parsePort(port: Json): PortMapping {
  return {
    hostAddress: port.hostAddress ?? port.hostIP ?? '0.0.0.0',
    hostPort: Number(port.hostPort),
    containerPort: Number(port.containerPort),
    proto: port.proto ?? port.protocol ?? 'tcp',
  };
}

export function formatPort(port: PortMapping): string {
  const host =
    port.hostAddress && port.hostAddress !== '0.0.0.0'
      ? `${port.hostAddress}:${port.hostPort}`
      : `${port.hostPort}`;
  return `${host}->${port.containerPort}/${port.proto}`;
}

/** mount.type is an enum encoded as a single-key object, e.g. {"volume": {...}} or {"virtiofs": {}} */
function parseMount(mount: Json): ContainerMount {
  const type: Json = mount.type ?? {};
  const options: string[] = Array.isArray(mount.options) ? mount.options : [];
  const readOnly = options.includes('ro');
  if (type.volume) {
    return {
      kind: 'volume',
      source: type.volume.name ?? mount.source,
      destination: mount.destination,
      readOnly,
    };
  }
  if (type.virtiofs) {
    return {
      kind: 'bind',
      source: mount.source,
      destination: mount.destination,
      readOnly,
    };
  }
  return {
    kind: Object.keys(type)[0] ?? 'unknown',
    source: mount.source ?? '',
    destination: mount.destination,
    readOnly,
  };
}

/** initProcess.user is either {raw: {userString}} or {id: {uid, gid}} */
function parseUser(user: Json | undefined): string | undefined {
  if (typeof user?.raw?.userString === 'string' && user.raw.userString) {
    return user.raw.userString;
  }
  return typeof user?.id?.uid === 'number' ? String(user.id.uid) : undefined;
}

export function parseContainers(data: unknown): ContainerSummary[] {
  return asArray(data).map(item => {
    const config: Json = item.configuration ?? {};
    const status: Json = item.status ?? {};
    const init: Json = config.initProcess ?? {};
    const command = [init.executable, ...(init.arguments ?? [])]
      .filter(Boolean)
      .join(' ');
    const statusNetworks = asArray(status.networks);
    const ipv4 = statusNetworks.find(n => n.ipv4Address)?.ipv4Address as
      string | undefined;
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
      networks: asArray(config.networks)
        .map(n => n.network)
        .filter(Boolean),
      ports: publishedPorts.map(formatPort),
      publishedPorts,
      mounts: asArray(config.mounts).map(parseMount),
      composeProject: labels[COMPOSE_PROJECT_LABEL],
      composeService: labels[COMPOSE_SERVICE_LABEL],
      cpus: config.resources?.cpus,
      memoryBytes: config.resources?.memoryInBytes,
      platform: platform
        ? [platform.os, platform.architecture, platform.variant]
            .filter(Boolean)
            .join('/')
        : undefined,
      user: parseUser(init.user),
      labels: {...labels},
      builder: labels[RESOURCE_ROLE_LABEL] === 'builder',
      workdir:
        typeof init.workingDirectory === 'string' && init.workingDirectory
          ? init.workingDirectory
          : undefined,
    };
  });
}

/**
 * Reproducible builds (SOURCE_DATE_EPOCH=0, e.g. Ubuntu 26.04's rockcraft images) set the image creation time to the
 * Unix epoch. Then fall back to the variant's `org.opencontainers.image.created` label or its last history entry,
 * preferring linux/arm64, the platform that runs on the Mac.
 */
function imageCreatedAt(
  creationDate: unknown,
  variants: Json[],
): string | undefined {
  if (typeof creationDate === 'string' && !isEpoch(creationDate)) {
    return creationDate;
  }
  const ordered = [
    ...variants.filter(v => v.platform?.architecture === 'arm64'),
    ...variants.filter(v => v.platform?.architecture !== 'arm64'),
  ];
  for (const variant of ordered) {
    const config: Json = variant.config ?? {};
    const candidates = [
      config.config?.Labels?.['org.opencontainers.image.created'],
      asArray(config.history).at(-1)?.created,
      config.created,
    ];
    const found = candidates.find(
      (c): c is string => typeof c === 'string' && !isEpoch(c),
    );
    if (found) {
      return found;
    }
  }
  return undefined;
}

function isEpoch(iso: string): boolean {
  const time = Date.parse(iso);
  return Number.isNaN(time) || time <= 0;
}

export function parseImages(data: unknown): ImageSummary[] {
  return asArray(data).map(item => {
    const config: Json = item.configuration ?? {};
    const variants = asArray(item.variants);
    const reference: string = config.name ?? item.id;
    return {
      reference,
      displayName: shortImageName(reference),
      digest: config.descriptor?.digest ?? item.id ?? '',
      createdAt: imageCreatedAt(config.creationDate, variants),
      sizeBytes: variants.reduce(
        (sum, v) => sum + (typeof v.size === 'number' ? v.size : 0),
        0,
      ),
      platforms: variants
        .map(v => v.platform)
        .filter(Boolean)
        .map((p: Json) =>
          [p.os, p.architecture, p.variant].filter(Boolean).join('/'),
        ),
    };
  });
}

export function parseNetworks(data: unknown): NetworkSummary[] {
  return asArray(data).map(item => {
    const config: Json = item.configuration ?? {};
    const status: Json = item.status ?? {};
    return {
      id: item.id ?? config.name,
      mode: config.mode,
      ipv4Subnet: status.ipv4Subnet,
      ipv4Gateway: status.ipv4Gateway,
      ipv6Subnet: status.ipv6Subnet,
      builtin: config.labels?.[RESOURCE_ROLE_LABEL] === 'builtin',
    };
  });
}

export function parseVolumes(data: unknown): VolumeSummary[] {
  return asArray(data).map(item => {
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
  return asArray(data).map(item => ({
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
    hostCpus: item.host?.cpus,
    operatingSystem: item.host?.operatingSystem,
    appRoot: item.paths?.appRoot,
    installRoot: item.paths?.installRoot,
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];

/**
 * `container cluster list --format json` (container 1.7.1). Node roles come from the configuration, addresses and
 * ports from the status; a configured node missing from the status has no status.
 */
function parseMachine(item: Json): MachineSummary {
  return {
    id: String(item.id),
    status: item.status ?? 'unknown',
    isDefault: item.default === true,
    ipv4: item.ipAddress ?? undefined,
    cpus: typeof item.cpus === 'number' ? item.cpus : undefined,
    memoryBytes: typeof item.memory === 'number' ? item.memory : undefined,
    diskBytes: typeof item.diskSize === 'number' ? item.diskSize : undefined,
    createdAt: toIsoDate(item.createdDate),
  };
}

/** `container machine list --format json` (container 1.7.1) */
export function parseMachines(data: unknown): MachineSummary[] {
  return asArray(data).map(parseMachine);
}

/** `container machine inspect`, which prints an array of one; it has no `default` field */
export function parseMachineInspect(data: unknown): MachineDetails | undefined {
  const [item] = asArray(data);
  if (!item) {
    return undefined;
  }
  const user = (item.userSetup ?? {}) as Json;
  const platform = (item.platform ?? {}) as Json;
  return {
    ...parseMachine(item),
    image: item.image?.reference,
    platform:
      platform.os && platform.architecture
        ? `${platform.os}/${platform.architecture}`
        : undefined,
    username: user.username,
    uid: typeof user.uid === 'number' ? user.uid : undefined,
    home: user.home,
    homeMount: item.homeMount,
    containerId: item.containerId ?? undefined,
    startedAt: toIsoDate(item.startedDate),
  };
}

export function parseClusters(data: unknown): ClusterSummary[] {
  return asArray(data).map(item => {
    const config = (item.configuration ?? {}) as Json;
    const status = (item.status ?? {}) as Json;
    const live = new Map(
      asArray(status.nodes).map(n => [String(n.name), n] as const),
    );
    const names = [
      ...asArray(config.nodes).map(n => String(n.name)),
      ...[...live.keys()].filter(
        name => !asArray(config.nodes).some(n => n.name === name),
      ),
    ];
    const nodes: ClusterNode[] = names.map(name => {
      const configured = asArray(config.nodes).find(n => n.name === name);
      const current = live.get(name);
      return {
        name,
        roles: strings(configured?.roles),
        status: current?.status,
        addresses: strings(current?.addresses),
        ports: strings(current?.ports),
      };
    });
    return {
      name: config.name ?? item.id,
      state: status.state ?? 'unknown',
      kubernetesVersion: config.kubernetesVersion ?? undefined,
      createdAt: toIsoDate(config.creationDate),
      sharedImageStore: config.sharedImageStore === true,
      cni: config.cni ?? undefined,
      nodes,
    };
  });
}

function parseDiskUsageEntry(item: Json | undefined): DiskUsageEntry {
  const count = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    total: count(item?.total),
    active: count(item?.active),
    sizeBytes: count(item?.sizeInBytes),
    reclaimableBytes: count(item?.reclaimable),
  };
}

/** `container system df --format json` */
export function parseDiskUsage(data: unknown): DiskUsage {
  const item = (data ?? {}) as Json;
  return {
    images: parseDiskUsageEntry(item.images),
    containers: parseDiskUsageEntry(item.containers),
    volumes: parseDiskUsageEntry(item.volumes),
  };
}

export function parseStats(data: unknown): ContainerStats[] {
  return asArray(data).map(item => ({...item, id: item.id}) as ContainerStats);
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
export function formatRelativeTime(
  iso: string | undefined,
  locale = 'en',
  now: Date = new Date(),
): string {
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
    rtf = new Intl.RelativeTimeFormat(locale, {numeric: 'auto'});
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
  }
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) {
      return rtf.format(value, unit);
    }
    value = Math.trunc(value / size);
  }
  return '';
}
