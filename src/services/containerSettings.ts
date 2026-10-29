// The container settings shown in the run / edit form, converted to and from `container run` arguments.
// No vscode dependency. Field layout of the inspect configuration follows apple/container 1.6.1.

import type { ContainerMount, PortMapping } from '../models/types';

type Json = Record<string, any>;

export interface ContainerSettings {
  ports: PortMapping[];
  mounts: ContainerMount[];
  /** KEY=VALUE, or a bare KEY that the CLI takes from this Mac's environment */
  env: string[];
  /** Networks to attach to; empty means the default network */
  networks: string[];
  /** Empty means the CLI default */
  cpus: string;
  /** e.g. 512M or 2G; empty means the CLI default */
  memory: string;
  /** name, uid or uid:gid; empty means the image default */
  user: string;
  /** Empty means the image default */
  workdir: string;
}

export const EMPTY_SETTINGS: ContainerSettings = {
  ports: [],
  mounts: [],
  env: [],
  networks: [],
  cpus: '',
  memory: '',
  user: '',
  workdir: '',
};

/** The editable settings of an existing container, from its inspect configuration */
export function settingsFromConfig(config: Json, ports: PortMapping[], mounts: ContainerMount[]): ContainerSettings {
  const init: Json = config.initProcess ?? {};
  const user: Json = init.user ?? {};
  let userSpec = '';
  if (user.raw?.userString) {
    userSpec = user.raw.userString;
  } else if (user.id && (user.id.uid !== 0 || user.id.gid !== 0)) {
    userSpec = `${user.id.uid}:${user.id.gid}`;
  }
  const resources: Json = config.resources ?? {};
  return {
    ports,
    mounts,
    env: [...(init.environment ?? [])],
    networks: (config.networks ?? []).map((n: Json) => n.network).filter(Boolean),
    cpus: resources.cpus ? String(resources.cpus) : '',
    // --memory has 1 MiB granularity
    memory: resources.memoryInBytes ? `${Math.round(resources.memoryInBytes / 1024 / 1024)}M` : '',
    user: userSpec,
    workdir: init.workingDirectory ?? '',
  };
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

/** Arguments for the settings, shared by `run` and recreating a container */
export function settingsArgs(settings: ContainerSettings): string[] {
  const args: string[] = [];
  for (const env of settings.env) {
    args.push('--env', env);
  }
  if (settings.workdir) {
    args.push('--workdir', settings.workdir);
  }
  if (settings.user) {
    args.push('--user', settings.user);
  }
  if (settings.cpus) {
    args.push('--cpus', settings.cpus);
  }
  if (settings.memory) {
    args.push('--memory', settings.memory);
  }
  for (const network of settings.networks) {
    args.push('--network', network);
  }
  for (const port of settings.ports) {
    args.push('--publish', formatPublishSpec(port));
  }
  for (const mount of settings.mounts) {
    args.push(...mountArgs(mount));
  }
  return args;
}

export interface RunForm {
  image: string;
  name: string;
  /** Shell script run with /bin/sh -c instead of the image command; empty keeps the image default */
  command: string;
  settings: ContainerSettings;
}

export function buildRunArgs(form: RunForm): string[] {
  const args = ['run', '--detach'];
  if (form.name) {
    args.push('--name', form.name);
  }
  args.push(...settingsArgs(form.settings));
  // --entrypoint replaces the image ENTRYPOINT too, so the script runs as is
  args.push(...(form.command ? ['--entrypoint', '/bin/sh', form.image, '-c', form.command] : [form.image]));
  return args;
}

/**
 * Parses a .env file into KEY=VALUE entries: comments, blank lines and `export` are skipped,
 * surrounding quotes are removed, and \n in double quotes becomes a newline.
 */
export function parseDotEnv(text: string): string[] {
  const entries: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let value = m[2];
    if (value.startsWith('"') && value.lastIndexOf('"') > 0) {
      value = value.slice(1, value.lastIndexOf('"')).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.lastIndexOf("'") > 0) {
      value = value.slice(1, value.lastIndexOf("'"));
    } else {
      // Unquoted values end at an inline comment
      value = value.replace(/\s+#.*$/, '');
    }
    entries.push(`${m[1]}=${value}`);
  }
  return entries;
}

/** Merges entries by key, later ones winning, keeping the first position of each key */
export function mergeEnv(base: string[], extra: string[]): string[] {
  const key = (entry: string) => entry.split('=', 1)[0];
  const merged = new Map(base.map((e) => [key(e), e]));
  for (const entry of extra) {
    merged.set(key(entry), entry);
  }
  return [...merged.values()];
}

export type ProblemReason =
  | 'portRange'
  | 'protocol'
  | 'duplicateHostPort'
  | 'relativeTarget'
  | 'relativeSource'
  | 'volumeName'
  | 'duplicateTarget'
  | 'envName'
  | 'cpus'
  | 'memory'
  | 'workdir'
  | 'name';

export interface SettingsProblem {
  section: 'ports' | 'mounts' | 'env' | 'resources' | 'process' | 'name';
  /** Zero-based row index within the section */
  index: number;
  reason: ProblemReason;
}

/** Returns the problems found; empty when the settings can be applied */
export function validateSettings(settings: ContainerSettings, name?: string): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  if (name !== undefined && name && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    problems.push({ section: 'name', index: 0, reason: 'name' });
  }
  const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  const seenHost = new Set<string>();
  settings.ports.forEach((p, index) => {
    const add = (reason: ProblemReason) => problems.push({ section: 'ports', index, reason });
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
  settings.mounts.forEach((m, index) => {
    const add = (reason: ProblemReason) => problems.push({ section: 'mounts', index, reason });
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
  settings.env.forEach((entry, index) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*(=|$)/.test(entry)) {
      problems.push({ section: 'env', index, reason: 'envName' });
    }
  });
  if (settings.cpus && !/^[1-9][0-9]*$/.test(settings.cpus)) {
    problems.push({ section: 'resources', index: 0, reason: 'cpus' });
  }
  if (settings.memory && !/^[1-9][0-9]*[KMGTP]?$/i.test(settings.memory)) {
    problems.push({ section: 'resources', index: 1, reason: 'memory' });
  }
  if (settings.workdir && !settings.workdir.startsWith('/')) {
    problems.push({ section: 'process', index: 0, reason: 'workdir' });
  }
  return problems;
}

/** Messages exchanged with the container form webview (webview-ui/src/views/ContainerForm.tsx) */
export type FormToWebview =
  | {
      type: 'init';
      mode: 'run' | 'edit';
      /** Container name when editing, the suggested name when running */
      name: string;
      image: string;
      /** Only for edit: whether the container is running */
      running: boolean;
      settings: ContainerSettings;
      volumes: string[];
      networks: string[];
    }
  | { type: 'browsed'; index: number; path: string }
  | { type: 'envImported'; env: string[] }
  | { type: 'problems'; messages: string[] }
  | { type: 'busy'; busy: boolean };

export type FormFromWebview =
  | { type: 'ready' }
  | { type: 'browse'; index: number }
  | { type: 'importEnv'; env: string[] }
  | { type: 'save'; name: string; command: string; settings: ContainerSettings }
  | { type: 'cancel' };
