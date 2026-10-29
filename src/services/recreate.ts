// Rebuilds `container run` / `container create` arguments from a container's inspect configuration,
// with edited settings. Apple container cannot change these on an existing container, so editing
// means deleting the container and creating it again. No vscode dependency.
// Field layout follows ContainerConfiguration / ProcessConfiguration of apple/container 1.6.1.

import { type ContainerSettings, settingsArgs } from './containerSettings';

type Json = Record<string, any>;

export interface RecreateOptions {
  /** `run --detach` for a running container, `create` for a stopped one */
  start: boolean;
  /** Image to create from; defaults to the container's own image (a snapshot when keeping changes) */
  image?: string;
}

/** RLIMIT_NOFILE -> nofile */
function ulimitName(limit: string): string {
  return limit.replace(/^RLIMIT_/i, '').toLowerCase();
}

/**
 * The form settings (ports, mounts, env, networks, resources, user, workdir) come from `settings`;
 * everything the form does not show is carried over from the configuration unchanged.
 */
export function buildRecreateArgs(config: Json, settings: ContainerSettings, options: RecreateOptions): string[] {
  const args: string[] = options.start ? ['run', '--detach'] : ['create'];
  args.push('--name', config.id);
  args.push(...settingsArgs(settings));

  const init: Json = config.initProcess ?? {};
  for (const limit of init.rlimits ?? []) {
    args.push('--ulimit', `${ulimitName(limit.limit)}=${limit.soft}:${limit.hard}`);
  }
  if (init.terminal) {
    args.push('--tty', '--interactive');
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

  // initProcess holds the resolved entrypoint + command, so pin both to keep the process identical
  if (init.executable) {
    args.push('--entrypoint', init.executable);
  }
  args.push(options.image ?? config.image?.reference);
  args.push(...(init.arguments ?? []));
  return args;
}
