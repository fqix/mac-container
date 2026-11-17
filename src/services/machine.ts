// Helpers for `container machine` (container 1.7.1): persistent Linux environments that boot the image's /sbin/init,
// with an account matching the Mac user and the Mac home directory mounted at its own path. No vscode dependency.

import {CliError} from './cli';

/** A CLI without `container machine` (before 1.7) reports it as an unknown command or plugin */
export function isMachineUnsupported(error: unknown): boolean {
  return (
    error instanceof CliError &&
    /unknown (sub)?command/i.test(error.stderr) &&
    /machine/.test(error.stderr)
  );
}

/** MachineConfiguration.validate (MachineConfiguration.swift): lowercase letters, digits and inner hyphens */
export function isValidMachineName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}

/**
 * A default name like the one `machine create` picks without --name (MachineCreate.swift): the last path component of
 * the image name and its tag. That name can fail the CLI's own validation (alpine:3.22 -> alpine-3.22, but dots are not
 * allowed), so it is lowercased and other characters become hyphens: alpine-3-22.
 */
export function defaultMachineName(image: string): string {
  const at = image.indexOf('@');
  const named = at >= 0 ? image.slice(0, at) : image;
  const colon = named.lastIndexOf(':');
  const tagged = colon > named.lastIndexOf('/');
  const repository = tagged ? named.slice(0, colon) : named;
  const tag = tagged ? named.slice(colon + 1) : 'latest';
  const base = repository.split('/').pop() ?? repository;
  return `${base}-${tag}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** home-mount values of `machine create` / `machine set` */
export type HomeMount = 'rw' | 'ro' | 'none';

/** Memory sizes as `machine set memory=` takes them: a number with an optional unit, e.g. 8G or 512M */
export function isValidMemory(value: string): boolean {
  return /^\d+(\.\d+)?\s*[kmgt]?i?b?$/i.test(value.trim());
}

/** Bytes as `machine set memory=` takes them: whole gibibytes as 8G, else mebibytes as 1536M */
export function memoryValue(bytes: number): string {
  const mib = 1024 * 1024;
  const gib = 1024 * mib;
  return bytes % gib === 0 ? `${bytes / gib}G` : `${Math.round(bytes / mib)}M`;
}

export interface MachineCreateOptions {
  image: string;
  name: string;
  cpus?: number;
  /** e.g. 8G; the CLI default is half of the Mac's memory */
  memory?: string;
  homeMount?: HomeMount;
  setDefault?: boolean;
  /** Registry options before the image, e.g. --scheme http for an insecure registry */
  registryArgs?: string[];
}

/** `container machine create`, which pulls the image if needed and boots the machine */
export function machineCreateArgs(options: MachineCreateOptions): string[] {
  return [
    'machine',
    'create',
    '--name',
    options.name,
    ...(options.cpus ? ['--cpus', String(options.cpus)] : []),
    ...(options.memory ? ['--memory', options.memory] : []),
    ...(options.homeMount ? ['--home-mount', options.homeMount] : []),
    ...(options.setDefault ? ['--set-default'] : []),
    '--progress',
    'plain',
    ...(options.registryArgs ?? []),
    options.image,
  ];
}

export interface MachineSettings {
  cpus?: number;
  memory?: string;
  homeMount?: HomeMount;
}

/** `container machine set`, which takes effect on the next boot; undefined when nothing changes */
export function machineSetArgs(
  id: string,
  settings: MachineSettings,
): string[] | undefined {
  const values = [
    ...(settings.cpus ? [`cpus=${settings.cpus}`] : []),
    ...(settings.memory ? [`memory=${settings.memory}`] : []),
    ...(settings.homeMount ? [`home-mount=${settings.homeMount}`] : []),
  ];
  return values.length
    ? ['machine', 'set', '--name', id, ...values]
    : undefined;
}

/** Quotes words for a POSIX shell; plain words stay as they are */
export function shellJoin(argv: string[]): string {
  return argv
    .map(arg =>
      /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`,
    )
    .join(' ');
}

export interface MachineRunOptions {
  /** Keep stdin open (-i) */
  stdin?: boolean;
  /** As root (--root) instead of the machine's account */
  root?: boolean;
  /** As this user instead of the machine's account */
  user?: string;
}

/**
 * `container machine run` arguments running `argv` in machine `id`, booting it first if it is stopped. The machine's
 * init runs a command as `<login shell> -c "$*"` (Resources/init of MachineAPIServer), so the arguments would be split
 * again by that shell: they are passed as one quoted command line instead.
 */
export function machineRunArgs(
  id: string,
  argv: string[],
  options: MachineRunOptions = {},
): string[] {
  return [
    'machine',
    'run',
    '--name',
    id,
    ...(options.stdin ? ['--interactive'] : []),
    ...(options.root
      ? ['--root']
      : options.user
        ? ['--user', options.user]
        : []),
    '--',
    shellJoin(argv),
  ];
}

/** Starts a stopped machine: `machine run` boots it and sets up its account before running the command */
export function machineStartArgs(id: string): string[] {
  return machineRunArgs(id, ['true']);
}
