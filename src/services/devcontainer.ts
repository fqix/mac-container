// devcontainer.json support: finds and parses the configuration, resolves its variables and turns it into
// `container build` / `container run` arguments and lifecycle commands. No vscode dependency.
// Follows https://containers.dev/implementors/json_reference/ ; the default workspace mount and the
// devcontainer.* labels follow the reference implementation (devcontainers/cli) so other tools recognize the container.

import { createHash } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import * as path from 'path';

import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

type Json = Record<string, any>;

export const LABEL_LOCAL_FOLDER = 'devcontainer.local_folder';
export const LABEL_CONFIG_FILE = 'devcontainer.config_file';
/** Hash of the configuration the container was created from, to offer a rebuild when it changes */
export const LABEL_CONFIG_HASH = 'apple-container.devcontainer.hash';

/** Search order of the spec: .devcontainer/devcontainer.json, .devcontainer.json, .devcontainer/<folder>/devcontainer.json */
export function findConfigFiles(
  folder: string,
  exists: (file: string) => boolean = existsSync,
  list: (dir: string) => string[] = (dir) => readdirSync(dir),
): string[] {
  const found: string[] = [];
  const main = path.join(folder, '.devcontainer', 'devcontainer.json');
  const root = path.join(folder, '.devcontainer.json');
  for (const candidate of [main, root]) {
    if (exists(candidate)) {
      found.push(candidate);
    }
  }
  const dir = path.join(folder, '.devcontainer');
  if (exists(dir)) {
    let entries: string[] = [];
    try {
      entries = list(dir).sort();
    } catch {
      // not a directory
    }
    for (const entry of entries) {
      const nested = path.join(dir, entry, 'devcontainer.json');
      if (exists(nested)) {
        found.push(nested);
      }
    }
  }
  return found;
}

/**
 * The local folder a configuration belongs to: the parent of .devcontainer for .devcontainer/devcontainer.json and
 * .devcontainer/<folder>/devcontainer.json, or the directory of .devcontainer.json
 */
export function localFolderOf(configFile: string): string {
  const dir = path.dirname(configFile);
  if (path.basename(dir) === '.devcontainer') {
    return path.dirname(dir);
  }
  if (path.basename(path.dirname(dir)) === '.devcontainer') {
    return path.dirname(path.dirname(dir));
  }
  return dir;
}

/** devcontainer.json is JSON with comments and trailing commas */
export function parseConfig(text: string, file: string): Json {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const { error, offset } = errors[0];
    const line = text.slice(0, offset).split('\n').length;
    throw new Error(`${file}:${line}: ${printParseErrorCode(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: expected an object`);
  }
  return value;
}

export interface Variables {
  localWorkspaceFolder: string;
  containerWorkspaceFolder: string;
  devcontainerId: string;
  localEnv: Record<string, string | undefined>;
}

/**
 * Replaces ${localWorkspaceFolder}, ${localWorkspaceFolderBasename}, ${containerWorkspaceFolder},
 * ${containerWorkspaceFolderBasename}, ${devcontainerId} and ${localEnv:NAME[:default]} (also the legacy ${env:NAME})
 * in every string of the value. ${containerEnv:NAME} is left for the container to resolve.
 */
export function substitute<T>(value: T, vars: Variables): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}:]+)(?::([^}:]*))?(?::([^}]*))?\}/g, (match, name: string, arg?: string, fallback?: string) => {
      switch (name) {
        case 'localWorkspaceFolder':
          return vars.localWorkspaceFolder;
        case 'localWorkspaceFolderBasename':
          return path.basename(vars.localWorkspaceFolder);
        case 'containerWorkspaceFolder':
          return vars.containerWorkspaceFolder;
        case 'containerWorkspaceFolderBasename':
          return path.posix.basename(vars.containerWorkspaceFolder);
        case 'devcontainerId':
          return vars.devcontainerId;
        case 'localEnv':
        case 'env':
          return arg ? (vars.localEnv[arg] ?? fallback ?? '') : match;
        default:
          return match;
      }
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, vars)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)])) as T;
  }
  return value;
}

/**
 * Converts a Docker --mount string or a devcontainer mount object to the CLI's type=,source=,target=[,readonly] form.
 * Docker-only keys such as consistency are dropped.
 */
export function mountSpec(mount: string | Json): string {
  const fields: Record<string, string | true> = {};
  if (typeof mount === 'string') {
    for (const part of mount.split(',')) {
      const [key, ...rest] = part.split('=');
      fields[key.trim().toLowerCase()] = rest.length ? rest.join('=').trim() : true;
    }
  } else {
    Object.assign(fields, mount);
  }
  const type = String(fields.type ?? 'volume');
  const source = fields.source ?? fields.src;
  const target = fields.target ?? fields.destination ?? fields.dst;
  const readonly = fields.readonly === true || fields.readonly === 'true' || fields.ro === true || fields.ro === 'true';
  const parts = [`type=${type}`];
  if (typeof source === 'string' && source) {
    parts.push(`source=${source}`);
  }
  parts.push(`target=${String(target)}`);
  if (readonly) {
    parts.push('readonly');
  }
  return parts.join(',');
}

/** "4gb" -> "4G"; the CLI takes K, M, G, T suffixes */
export function memorySpec(value: string): string | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb)?\s*$/i.exec(value);
  if (!m) {
    return undefined;
  }
  const units = ['kb', 'mb', 'gb', 'tb'];
  let amount = Number(m[1]);
  let unit = units.indexOf((m[2] ?? 'mb').toLowerCase());
  // The CLI wants whole numbers; step down a unit for fractions such as 1.5gb
  while (!Number.isInteger(amount) && unit > 0) {
    amount *= 1024;
    unit--;
  }
  return `${Math.round(amount)}${'KMGT'[unit]}`;
}

export type LifecycleCommand = string | string[] | Record<string, string | string[]>;

export const LIFECYCLE = ['initializeCommand', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand'] as const;
export type LifecycleName = (typeof LIFECYCLE)[number];

export interface CommandStep {
  /** Name of a command in the object form, used as the task title */
  label?: string;
  argv: string[];
}

/**
 * A string runs through /bin/sh, an array runs as is, and each entry of an object runs in parallel.
 * Returns the steps that run in parallel; empty when the command is not set.
 */
export function commandSteps(command: LifecycleCommand | undefined): CommandStep[] {
  if (command === undefined || command === null || command === '') {
    return [];
  }
  if (typeof command === 'string') {
    return [{ argv: ['/bin/sh', '-c', command] }];
  }
  if (Array.isArray(command)) {
    return command.length ? [{ argv: command.map(String) }] : [];
  }
  return Object.entries(command).flatMap(([label, value]) => commandSteps(value).map((step) => ({ ...step, label })));
}

/** Keeps the container alive instead of the image command, as overrideCommand does in Docker-based tools */
const KEEP_ALIVE = 'echo Container started; trap "exit 0" TERM; while sleep 1000 & wait $!; do :; done';

export interface DevContainerPlan {
  /** Display name: the config's name or the folder name */
  name: string;
  /** Container ID, stable for a folder and config file */
  containerName: string;
  /** Image to run: the configured image or the tag of the build */
  image: string;
  build?: { args: string[]; context: string };
  runArgs: string[];
  workspaceFolder: string;
  /** User for SSH and lifecycle commands; undefined means the container's own user */
  remoteUser?: string;
  remoteEnv: Record<string, string>;
  lifecycle: Partial<Record<LifecycleName, CommandStep[]>>;
  /** Properties that are set but cannot be applied with Apple container */
  unsupported: string[];
  configHash: string;
}

export interface PlanInput {
  config: Json;
  configFile: string;
  configText: string;
  localWorkspaceFolder: string;
  localEnv: Record<string, string | undefined>;
  /** Contents of the Dockerfile when the config builds one, so editing it also offers a rebuild */
  dockerfileText?: string;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '') || 'devcontainer';
}

/** Readable, stable container name for a dev container: devc-<folder>-<hash of folder and config file> */
export function devContainerName(localWorkspaceFolder: string, configFile: string): string {
  return `devc-${slug(path.basename(localWorkspaceFolder))}-${hash(localWorkspaceFolder, configFile).slice(0, 8)}`;
}

export function hash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const part of parts) {
    h.update(part).update('\0');
  }
  return h.digest('hex');
}

/** Throws when the configuration cannot start a container at all */
export function planDevContainer(input: PlanInput): DevContainerPlan {
  const { configFile, localWorkspaceFolder } = input;
  const basename = path.basename(localWorkspaceFolder);
  const idHash = hash(localWorkspaceFolder, configFile).slice(0, 12);
  const devcontainerId = idHash;

  // workspaceFolder may refer to other variables, so resolve it first with a provisional container folder
  const defaultFolder = `/workspaces/${basename}`;
  const preliminary = substitute(input.config, { localWorkspaceFolder, containerWorkspaceFolder: defaultFolder, devcontainerId, localEnv: input.localEnv });
  const workspaceFolder: string = typeof preliminary.workspaceFolder === 'string' && preliminary.workspaceFolder ? preliminary.workspaceFolder : defaultFolder;
  const config: Json = substitute(input.config, { localWorkspaceFolder, containerWorkspaceFolder: workspaceFolder, devcontainerId, localEnv: input.localEnv });

  const unsupported: string[] = [];
  if (config.features && Object.keys(config.features).length) {
    unsupported.push('features');
  }
  if (config.dockerComposeFile) {
    unsupported.push('dockerComposeFile');
  }
  if (config.privileged) {
    unsupported.push('privileged');
  }
  if (Array.isArray(config.securityOpt) && config.securityOpt.length) {
    unsupported.push('securityOpt');
  }
  if (config.customizations?.vscode?.extensions?.length) {
    unsupported.push('customizations.vscode.extensions');
  }
  if (config.hostRequirements?.gpu) {
    unsupported.push('hostRequirements.gpu');
  }

  const configDir = path.dirname(configFile);
  const name = typeof config.name === 'string' && config.name ? config.name : basename;
  const containerName = devContainerName(localWorkspaceFolder, configFile);

  let image: string;
  let build: DevContainerPlan['build'];
  const dockerfile: string | undefined = config.build?.dockerfile ?? config.dockerFile;
  if (dockerfile) {
    const context = path.resolve(configDir, config.build?.context ?? '.');
    image = `vsc-${slug(basename)}-${idHash.slice(0, 8)}:latest`;
    const args = ['build', '--progress', 'plain', '--file', path.resolve(configDir, dockerfile), '--tag', image];
    for (const [key, value] of Object.entries<string>(config.build?.args ?? {})) {
      args.push('--build-arg', `${key}=${value}`);
    }
    if (config.build?.target) {
      args.push('--target', config.build.target);
    }
    args.push(...(config.build?.options ?? []).map(String), context);
    build = { args, context };
  } else if (typeof config.image === 'string' && config.image) {
    image = config.image;
  } else if (config.dockerComposeFile) {
    throw new Error('dockerComposeFile is not supported; add an image or build to the configuration');
  } else {
    throw new Error('the configuration needs an image or a build with a dockerfile');
  }

  const configHash = hash(input.configText, input.dockerfileText ?? '').slice(0, 16);
  const run: string[] = ['run', '--detach', '--name', containerName];
  run.push(
    '--label', `${LABEL_LOCAL_FOLDER}=${localWorkspaceFolder}`,
    '--label', `${LABEL_CONFIG_FILE}=${configFile}`,
    '--label', `${LABEL_CONFIG_HASH}=${configHash}`,
  );
  run.push('--mount', typeof config.workspaceMount === 'string' && config.workspaceMount
    ? mountSpec(config.workspaceMount)
    : `type=bind,source=${localWorkspaceFolder},target=${workspaceFolder}`);
  for (const mount of Array.isArray(config.mounts) ? config.mounts : []) {
    run.push('--mount', mountSpec(mount));
  }
  for (const [key, value] of Object.entries<string>(config.containerEnv ?? {})) {
    run.push('--env', `${key}=${value}`);
  }
  // forwardPorts become loopback-only published ports; appPort is published as written
  for (const port of Array.isArray(config.forwardPorts) ? config.forwardPorts : []) {
    const n = typeof port === 'number' ? port : /^(?:localhost:)?(\d+)$/.exec(String(port))?.[1];
    if (n) {
      run.push('--publish', `127.0.0.1:${n}:${n}`);
    }
  }
  const appPorts = config.appPort === undefined ? [] : Array.isArray(config.appPort) ? config.appPort : [config.appPort];
  for (const port of appPorts) {
    run.push('--publish', typeof port === 'number' ? `${port}:${port}` : String(port));
  }
  if (config.containerUser) {
    run.push('--user', String(config.containerUser));
  }
  if (Number.isInteger(config.hostRequirements?.cpus)) {
    run.push('--cpus', String(config.hostRequirements.cpus));
  }
  const memory = typeof config.hostRequirements?.memory === 'string' ? memorySpec(config.hostRequirements.memory) : undefined;
  if (memory) {
    run.push('--memory', memory);
  }
  for (const cap of Array.isArray(config.capAdd) ? config.capAdd : []) {
    run.push('--cap-add', String(cap));
  }
  if (config.init) {
    run.push('--init');
  }
  run.push(...(Array.isArray(config.runArgs) ? config.runArgs.map(String) : []));
  if (config.overrideCommand === false) {
    run.push(image);
  } else {
    run.push('--entrypoint', '/bin/sh', image, '-c', KEEP_ALIVE);
  }

  const lifecycle: DevContainerPlan['lifecycle'] = {};
  for (const key of LIFECYCLE) {
    const steps = commandSteps(config[key]);
    if (steps.length) {
      lifecycle[key] = steps;
    }
  }

  return {
    name,
    containerName,
    image,
    build,
    runArgs: run,
    workspaceFolder,
    remoteUser: config.remoteUser ?? config.containerUser ?? undefined,
    remoteEnv: Object.fromEntries(Object.entries<string>(config.remoteEnv ?? {}).filter(([, v]) => v !== null && v !== undefined)),
    lifecycle,
    unsupported,
    configHash,
  };
}

/**
 * `container exec` arguments running a lifecycle step in the workspace folder as the remote user,
 * with remoteEnv (already resolved against the container environment) applied like the tool's own processes
 */
export function execArgs(
  plan: Pick<DevContainerPlan, 'containerName' | 'workspaceFolder' | 'remoteUser'>,
  step: CommandStep,
  remoteEnv: Record<string, string> = {},
): string[] {
  const args = ['exec', '--workdir', plan.workspaceFolder];
  if (plan.remoteUser) {
    args.push('--user', plan.remoteUser);
  }
  for (const [key, value] of Object.entries(remoteEnv)) {
    args.push('--env', `${key}=${value}`);
  }
  return [...args, plan.containerName, ...step.argv];
}
