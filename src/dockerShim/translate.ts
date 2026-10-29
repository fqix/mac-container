// Translates the docker CLI calls made by devcontainers/cli into Apple container CLI calls.
// Pure functions only, so they can be unit tested; the process handling lives in main.ts.

import { devContainerName, LABEL_CONFIG_FILE, LABEL_LOCAL_FOLDER, mountSpec } from '../services/devcontainer';
import { parseContainers } from '../utils/parse';

type Json = Record<string, any>;

/** Version reported to devcontainers/cli; it only parses major.minor.patch */
export const SHIM_VERSION = '27.0.0';

/** docker flags that take no value; any other flag without `=` consumes the next argument */
const DOCKER_BOOLEAN_FLAGS = new Set([
  '-d', '--detach', '-i', '--interactive', '-t', '--tty', '--rm', '--init', '--privileged', '--read-only',
  '-P', '--publish-all', '--sig-proxy', '--oom-kill-disable', '--no-healthcheck', '--disable-content-trust',
  '-q', '--quiet', '-a', '--all', '-f', '--force', '--no-cache', '--pull', '--load', '--push', '--force-rm',
  '--squash', '--compress', '--no-trunc', '-s', '--size', '-l', '--latest', '-n',
]);

/** Flags whose meaning depends on the command: `-a` is a boolean for ps but takes a value for run */
const VALUE_FLAGS_BY_COMMAND: Record<string, string[]> = {
  run: ['-a', '--attach', '-l', '-f'],
  create: ['-a', '--attach', '-l', '-f'],
  build: ['-f', '-l', '-t'],
  exec: [],
  ps: ['-n', '-f'],
  stop: ['-t', '-s'],
  inspect: ['-f'],
  events: ['-f'],
  info: ['-f'],
  version: ['-f'],
};

export interface DockerOption {
  name: string;
  value?: string;
}

export interface SplitArgs {
  options: DockerOption[];
  /** Positional arguments, starting with the first non-option */
  rest: string[];
}

/** Splits docker style arguments into options and positionals, stopping at the first positional */
export function splitOptions(command: string, args: string[]): SplitArgs {
  const valueFlags = new Set(VALUE_FLAGS_BY_COMMAND[command] ?? []);
  const takesValue = (name: string) => valueFlags.has(name) || !DOCKER_BOOLEAN_FLAGS.has(name);
  const options: DockerOption[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      break;
    }
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      options.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      continue;
    }
    // Combined short booleans such as -it
    if (!arg.startsWith('--') && arg.length > 2) {
      const flags = arg.slice(1).split('').map((c) => `-${c}`);
      if (flags.every((f) => !takesValue(f))) {
        options.push(...flags.map((name) => ({ name })));
        continue;
      }
      // -uroot style: short flag with an attached value
      options.push({ name: arg.slice(0, 2), value: arg.slice(2) });
      continue;
    }
    if (takesValue(arg) && i + 1 < args.length) {
      options.push({ name: arg, value: args[++i] });
    } else {
      options.push({ name: arg });
    }
  }
  return { options, rest: args.slice(i) };
}

/** Option name → whether it takes a value, parsed from `container <command> --help` */
export function parseHelpOptions(help: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const line of help.split('\n')) {
    const m = /^\s{1,4}(-{1,2}[A-Za-z0-9][\w-]*(?:,\s*-{1,2}[A-Za-z0-9][\w-]*)*)(\s+<[^>]+>)?/.exec(line);
    if (!m) {
      continue;
    }
    for (const name of m[1].split(',')) {
      result.set(name.trim(), !!m[2]);
    }
  }
  return result;
}

export interface Translated {
  args: string[];
  warnings: string[];
}

const HOST_ONLY_PATH = /^\/(dev|proc|sys)(\/|$)/;

/** Docker run options turned into Apple container options; unsupported ones are dropped with a warning */
export function translateRunOptions(
  options: DockerOption[],
  apple: Map<string, boolean>,
  pathExists: (path: string) => boolean,
): Translated {
  const args: string[] = [];
  const warnings: string[] = [];
  const drop = (option: DockerOption, why: string) =>
    warnings.push(`ignoring ${option.value === undefined ? option.name : `${option.name} ${option.value}`}: ${why}`);
  const unusableSource = (source: string) =>
    source.startsWith('/') && (HOST_ONLY_PATH.test(source) || !pathExists(source));

  for (const option of options) {
    const { name, value } = option;
    switch (name) {
      // Attach and signal proxy options only matter for the docker client; the shim always detaches
      case '--sig-proxy':
      case '-a':
      case '--attach':
      case '-d':
      case '--detach':
        continue;
      case '--privileged':
        warnings.push('--privileged is not supported by Apple container; adding all capabilities with --cap-add ALL instead');
        args.push('--cap-add', 'ALL');
        continue;
      case '-v':
      case '--volume': {
        const source = (value ?? '').split(':')[0];
        if (unusableSource(source)) {
          drop(option, `${source} is not available to Apple container containers`);
          continue;
        }
        args.push('--volume', value ?? '');
        continue;
      }
      case '--mount': {
        const spec = mountSpec(value ?? '');
        const source = /(?:^|,)source=([^,]*)/.exec(spec)?.[1] ?? '';
        if (spec.startsWith('type=bind') && unusableSource(source)) {
          drop(option, `${source} is not available to Apple container containers`);
          continue;
        }
        args.push('--mount', spec);
        continue;
      }
      case '--network':
      case '--net':
        if (value === 'host' || value === 'none' || value?.startsWith('container:')) {
          drop(option, 'Apple container has no host or shared network mode');
          continue;
        }
        args.push('--network', value ?? '');
        continue;
    }
    if (!apple.has(name)) {
      drop(option, 'not supported by Apple container');
      continue;
    }
    args.push(name);
    if (apple.get(name) && value !== undefined) {
      args.push(value);
    }
  }
  // docker would pick a random name and Apple container a UUID; dev containers get a readable, stable one
  const named = options.some((o) => o.name === '--name');
  const labels = Object.fromEntries(
    options.filter((o) => (o.name === '-l' || o.name === '--label') && o.value?.includes('=')).map((o) => {
      const eq = o.value!.indexOf('=');
      return [o.value!.slice(0, eq), o.value!.slice(eq + 1)];
    }),
  );
  if (!named && labels[LABEL_LOCAL_FOLDER] && labels[LABEL_CONFIG_FILE]) {
    args.push('--name', devContainerName(labels[LABEL_LOCAL_FOLDER], labels[LABEL_CONFIG_FILE]));
  }
  return { args, warnings };
}

/** Environment variable with a JSON array of `container run` options added when the run does not set them itself */
export const RUN_DEFAULTS_ENV = 'DOCKER_SHIM_RUN_DEFAULTS';

/** Option names that set the same thing, so a default is skipped when any of them is already present */
const ALIASES: Record<string, string[]> = {
  '--cpus': ['--cpus', '-c'],
  '--memory': ['--memory', '-m'],
};

/**
 * Adds default options (pairs such as ["--memory", "4G"]) that the translated run arguments do not set.
 * Docker containers share the whole Docker VM, while every Apple container VM gets 1 GB unless told otherwise.
 */
export function applyRunDefaults(args: string[], defaults: string[]): string[] {
  const result = [...args];
  for (let i = 0; i + 1 < defaults.length; i += 2) {
    const names = ALIASES[defaults[i]] ?? [defaults[i]];
    if (!args.some((arg) => names.includes(arg))) {
      result.push(defaults[i], defaults[i + 1]);
    }
  }
  return result;
}

/** Parses the run defaults from the environment; anything malformed is ignored */
export function parseRunDefaults(value: string | undefined): string[] {
  try {
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

/** Options passed through when Apple container knows them; others are dropped with a warning */
export function passKnownOptions(options: DockerOption[], apple: Map<string, boolean>): Translated {
  const args: string[] = [];
  const warnings: string[] = [];
  for (const { name, value } of options) {
    if (!apple.has(name)) {
      warnings.push(`ignoring ${value === undefined ? name : `${name} ${value}`}: not supported by Apple container`);
      continue;
    }
    args.push(name);
    if (apple.get(name) && value !== undefined) {
      args.push(value);
    }
  }
  return { args, warnings };
}

/** Docker build options turned into Apple container build options; --load is what Apple container does anyway */
export function translateBuildOptions(options: DockerOption[], apple: Map<string, boolean>): Translated {
  return passKnownOptions(options.filter((o) => o.name !== '--load'), apple);
}

export interface Filters {
  [key: string]: string[];
}

/** --filter key=value options grouped by key */
export function parseFilters(options: DockerOption[]): Filters {
  const filters: Filters = {};
  for (const { name, value } of options) {
    if ((name === '--filter' || name === '-f') && value) {
      const eq = value.indexOf('=');
      const key = eq < 0 ? value : value.slice(0, eq);
      (filters[key] ??= []).push(eq < 0 ? '' : value.slice(eq + 1));
    }
  }
  return filters;
}

function labelMatches(labels: Record<string, string>, filter: string): boolean {
  const eq = filter.indexOf('=');
  return eq < 0 ? filter in labels : labels[filter.slice(0, eq)] === filter.slice(eq + 1);
}

/** Containers (Apple JSON) matching docker ps style filters */
export function filterContainers(items: Json[], filters: Filters, all: boolean): Json[] {
  return items.filter((item) => {
    const summary = parseContainers([item])[0];
    if (!all && summary.state !== 'running') {
      return false;
    }
    if (!(filters.label ?? []).every((f) => labelMatches(summary.labels, f))) {
      return false;
    }
    const ids = [...(filters.id ?? []), ...(filters.name ?? [])];
    return !ids.length || ids.some((id) => summary.id === id || summary.id.startsWith(id));
  });
}

const ZERO_TIME = '0001-01-01T00:00:00Z';

/** Apple container inspect output in the shape devcontainers/cli reads from `docker inspect --type container` */
export function toDockerContainer(item: Json): Json {
  const summary = parseContainers([item])[0];
  const init: Json = item.configuration?.initProcess ?? {};
  const running = summary.state === 'running';
  // No --user gives {id: {uid: 0, gid: 0}}, which docker reports as an empty user
  const uid = init.user?.id;
  const user = uid && uid.uid === 0 && uid.gid === 0 ? '' : (summary.user ?? '');
  const ports: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const port of summary.publishedPorts) {
    (ports[`${port.containerPort}/${port.proto}`] ??= []).push({ HostIp: port.hostAddress, HostPort: String(port.hostPort) });
  }
  return {
    Id: summary.id,
    Name: `/${summary.id}`,
    Created: summary.createdAt ?? ZERO_TIME,
    Image: summary.image,
    State: {
      Status: running ? 'running' : summary.state === 'stopped' ? 'exited' : summary.state,
      Running: running,
      StartedAt: summary.startedAt ?? ZERO_TIME,
      FinishedAt: ZERO_TIME,
    },
    Config: {
      Image: summary.image,
      User: user,
      Env: Array.isArray(init.environment) ? init.environment : null,
      Labels: summary.labels,
      WorkingDir: summary.workdir ?? '',
      Entrypoint: init.executable ? [init.executable] : null,
      Cmd: Array.isArray(init.arguments) ? init.arguments : null,
    },
    Mounts: summary.mounts.map((m) => ({
      Type: m.kind,
      ...(m.kind === 'volume' ? { Name: m.source } : {}),
      Source: m.source,
      Destination: m.destination,
      RW: !m.readOnly,
    })),
    NetworkSettings: {
      IPAddress: summary.ipv4 ?? '',
      Ports: ports,
    },
  };
}

/** Apple image inspect output in the shape devcontainers/cli reads from `docker inspect --type image` */
export function toDockerImage(item: Json, arch: string): Json {
  const variants: Json[] = Array.isArray(item.variants) ? item.variants : [];
  const linux = variants.filter((v) => v.platform?.os === 'linux');
  const variant = linux.find((v) => v.platform?.architecture === arch) ?? linux[0] ?? variants[0] ?? {};
  const config: Json = variant.config?.config ?? {};
  const id = String(item.id ?? '');
  return {
    Id: id.startsWith('sha256:') ? id : `sha256:${id}`,
    RepoTags: item.configuration?.name ? [item.configuration.name] : [],
    Architecture: variant.platform?.architecture ?? arch,
    Variant: variant.platform?.variant,
    Os: variant.platform?.os ?? 'linux',
    Created: variant.config?.created ?? item.configuration?.creationDate,
    Config: {
      User: config.User ?? '',
      Env: config.Env ?? null,
      Labels: config.Labels ?? null,
      Entrypoint: config.Entrypoint ?? null,
      Cmd: config.Cmd ?? null,
      WorkingDir: config.WorkingDir ?? '',
    },
  };
}

export interface ContainerState {
  state: string;
  labels: Record<string, string>;
  startedAt?: string;
}

/** Container states keyed by id, from `container ls --all --format json` */
export function snapshot(items: Json[]): Map<string, ContainerState> {
  return new Map(
    parseContainers(items).map((c) => [c.id, { state: c.state, labels: c.labels, startedAt: c.startedAt }]),
  );
}

/**
 * docker events (as JSON lines) between two snapshots. `since` lets the first poll report containers that
 * started after the events command was launched, which can happen before the first snapshot is taken.
 */
export function diffEvents(
  previous: Map<string, ContainerState> | undefined,
  current: Map<string, ContainerState>,
  filters: Filters,
  since: number,
): Json[] {
  const events: Json[] = [];
  const emit = (action: string, id: string, labels: Record<string, string>) =>
    events.push({
      status: action,
      Action: action,
      id,
      Type: 'container',
      Actor: { ID: id, Attributes: { ...labels, name: id } },
      time: Math.floor(Date.now() / 1000),
    });
  for (const [id, now] of current) {
    const before = previous?.get(id);
    if (now.state === 'running') {
      const startedSince = !previous && now.startedAt !== undefined && Date.parse(now.startedAt) >= since;
      if (previous ? before?.state !== 'running' : startedSince) {
        emit('start', id, now.labels);
      }
    } else if (before?.state === 'running') {
      emit('die', id, now.labels);
      emit('stop', id, now.labels);
    }
  }
  for (const [id, before] of previous ?? []) {
    if (!current.has(id)) {
      emit('destroy', id, before.labels);
    }
  }
  return events.filter((event) => {
    const labels = event.Actor.Attributes;
    return (
      (!filters.event?.length || filters.event.includes(event.Action)) &&
      (!filters.type?.length || filters.type.includes('container')) &&
      (!filters.container?.length || filters.container.includes(event.id)) &&
      (filters.label ?? []).every((f) => labelMatches(labels, f))
    );
  });
}
