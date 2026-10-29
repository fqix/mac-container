// docker-compatible entry point for devcontainers/cli (`--docker-path`), backed by the Apple container CLI.
// Only the commands devcontainers/cli uses are implemented; see translate.ts for the argument and JSON mapping.

import { execFile, execFileSync, spawn } from 'child_process';
import { appendFileSync, existsSync } from 'fs';
import * as path from 'path';

import {
  applyRunDefaults,
  diffEvents,
  filterContainers,
  parseFilters,
  parseHelpOptions,
  parseRunDefaults,
  passKnownOptions,
  RUN_DEFAULTS_ENV,
  SHIM_VERSION,
  snapshot,
  splitOptions,
  toDockerContainer,
  toDockerImage,
  translateBuildOptions,
  translateRunOptions,
  type ContainerState,
} from './translate';

/** The extension passes the resolved CLI path; standalone use falls back to PATH and the Homebrew locations */
function containerCli(): string {
  const configured = process.env.APPLE_CONTAINER_CLI;
  if (configured) {
    return configured;
  }
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.map((dir) => path.join(dir, 'container')).find((file) => path.isAbsolute(file) && existsSync(file)) ?? 'container';
}

const CLI = containerCli();

function log(message: string): void {
  const file = process.env.DOCKER_SHIM_LOG;
  if (file) {
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  }
}

function warn(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`docker-shim: ${warning}\n`);
    log(`warning: ${warning}`);
  }
}

function fail(message: string, code = 1): number {
  process.stderr.write(`${message}\n`);
  log(`error: ${message}`);
  return code;
}

const helpCache = new Map<string, Map<string, boolean>>();

/** Options Apple container accepts for a (sub)command */
function appleOptions(...command: string[]): Map<string, boolean> {
  const key = command.join(' ');
  let options = helpCache.get(key);
  if (!options) {
    options = parseHelpOptions(execFileSync(CLI, [...command, '--help'], { encoding: 'utf8' }));
    helpCache.set(key, options);
  }
  return options;
}

/** Runs the CLI and collects its output */
function capture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  log(`capture: container ${args.join(' ')}`);
  return new Promise((resolve) => {
    execFile(CLI, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Runs the CLI with this process's stdio, forwarding termination signals */
function passthrough(args: string[]): Promise<number> {
  log(`run: container ${args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGTERM', forward);
    process.on('SIGINT', forward);
    child.on('error', (err) => resolve(fail(`docker-shim: ${err.message}`)));
    child.on('exit', (code, signal) => {
      process.off('SIGTERM', forward);
      process.off('SIGINT', forward);
      resolve(code ?? (signal ? 128 + 15 : 1));
    });
  });
}

async function listContainers(): Promise<Record<string, any>[]> {
  const { code, stdout, stderr } = await capture(['ls', '--all', '--format', 'json']);
  if (code !== 0) {
    throw new Error(stderr.trim() || `container ls failed (exit ${code})`);
  }
  return stdout.trim() ? JSON.parse(stdout) : [];
}

const imageArch = process.arch === 'x64' ? 'amd64' : process.arch;

async function inspectOne(id: string, type: string | undefined): Promise<Record<string, any> | undefined> {
  if (type !== 'image') {
    const { code, stdout } = await capture(['inspect', id]);
    const items = code === 0 && stdout.trim() ? JSON.parse(stdout) : [];
    if (items.length) {
      return toDockerContainer(items[0]);
    }
    if (type === 'container') {
      return undefined;
    }
  }
  const { code, stdout } = await capture(['image', 'inspect', id]);
  const items = code === 0 && stdout.trim() ? JSON.parse(stdout) : [];
  return items.length ? toDockerImage(items[0], imageArch) : undefined;
}

async function inspect(args: string[]): Promise<number> {
  const { options, rest } = splitOptions('inspect', args);
  const type = options.find((o) => o.name === '--type')?.value;
  if (type && type !== 'container' && type !== 'image') {
    return fail(`docker-shim: inspect --type ${type} is not supported`);
  }
  const results = await Promise.all(rest.map((id) => inspectOne(id, type)));
  process.stdout.write(`${JSON.stringify(results.filter(Boolean), null, 2)}\n`);
  const missing = rest.filter((_, i) => !results[i]);
  return missing.length ? fail(missing.map((id) => `Error: No such object: ${id}`).join('\n')) : 0;
}

async function ps(args: string[]): Promise<number> {
  const { options } = splitOptions('ps', args);
  const all = options.some((o) => o.name === '-a' || o.name === '--all');
  const matches = filterContainers(await listContainers(), parseFilters(options), all);
  for (const item of matches) {
    process.stdout.write(`${item.id ?? item.configuration?.id}\n`);
  }
  return 0;
}

/** docker events, emulated by polling the container list */
async function events(args: string[]): Promise<number> {
  const filters = parseFilters(splitOptions('events', args).options);
  const since = Date.now() - 1000;
  let previous: Map<string, ContainerState> | undefined;
  let stopped = false;
  const stop = () => (stopped = true);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.on('error', stop);
  while (!stopped) {
    try {
      const current = snapshot(await listContainers());
      for (const event of diffEvents(previous, current, filters, since)) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      previous = current;
    } catch (err) {
      log(`events: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 0;
}

async function run(args: string[]): Promise<number> {
  const { options, rest } = splitOptions('run', args);
  const [image, ...command] = rest;
  if (!image) {
    return fail('docker-shim: run needs an image');
  }
  const detach = options.some((o) => o.name === '-d' || o.name === '--detach');
  const translated = translateRunOptions(options, appleOptions('run'), existsSync);
  warn(translated.warnings);
  const runArgs = applyRunDefaults(translated.args, parseRunDefaults(process.env[RUN_DEFAULTS_ENV]));
  // Always start detached: a foreground `container run` could take the container down with the client
  // when devcontainers/cli exits. Attached runs are emulated by following the logs instead.
  const started = await capture(['run', '--detach', ...runArgs, image, ...command]);
  process.stderr.write(started.stderr);
  if (started.code !== 0) {
    return started.code;
  }
  const id = started.stdout.trim().split('\n').pop() ?? '';
  if (detach) {
    process.stdout.write(`${id}\n`);
    return 0;
  }
  return passthrough(['logs', '--follow', id]);
}

async function build(args: string[]): Promise<number> {
  const { options, rest } = splitOptions('build', args);
  const { args: buildArgs, warnings } = translateBuildOptions(options, appleOptions('build'));
  warn(warnings);
  return passthrough(['build', ...buildArgs, ...rest]);
}

async function exec(args: string[]): Promise<number> {
  const { options, rest } = splitOptions('exec', args);
  const { args: execArgs, warnings } = passKnownOptions(options, appleOptions('exec'));
  warn(warnings);
  return passthrough(['exec', ...execArgs, ...rest]);
}

async function stop(args: string[]): Promise<number> {
  const { options, rest } = splitOptions('stop', args);
  const { args: stopArgs, warnings } = passKnownOptions(options, appleOptions('stop'));
  warn(warnings);
  return passthrough(['stop', ...stopArgs, ...rest]);
}

async function rm(args: string[]): Promise<number> {
  const { options, rest } = splitOptions('rm', args);
  const force = options.some((o) => o.name === '-f' || o.name === '--force');
  return passthrough(['delete', ...(force ? ['--force'] : []), ...rest]);
}

function version(args: string[]): number {
  const format = splitOptions('version', args).options.find((o) => o.name === '--format' || o.name === '-f');
  process.stdout.write(format ? `${SHIM_VERSION}\n` : `Docker version ${SHIM_VERSION}, build apple-container-shim\n`);
  return 0;
}

function info(args: string[]): number {
  const format = splitOptions('info', args).options.find((o) => o.name === '--format' || o.name === '-f')?.value ?? '';
  // Neither SELinux nor the nvidia runtime exist in Apple container VMs
  process.stdout.write(format.includes('SELinux') ? 'false\n' : '\n');
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  log(`docker ${argv.join(' ')}`);
  const [command, ...args] = argv;
  switch (command) {
    case '-v':
    case '--version':
      return version([]);
    case 'version':
      return version(args);
    case 'info':
      return info(args);
    case 'buildx':
      // Makes devcontainers/cli use plain `docker build`, whose features fallback needs no --build-context
      return fail("docker: 'buildx' is not a docker command.");
    case 'build':
      return build(args);
    case 'run':
      return run(args);
    case 'exec':
      return exec(args);
    case 'inspect':
      return inspect(args);
    case 'ps':
      return ps(args);
    case 'events':
      return events(args);
    case 'start':
      return passthrough(['start', ...splitOptions('start', args).rest]);
    case 'stop':
      return stop(args);
    case 'rm':
      return rm(args);
    case 'logs':
      return passthrough(['logs', ...args]);
    case 'pull':
      return passthrough(['image', 'pull', ...splitOptions('pull', args).rest]);
    case 'tag':
      return passthrough(['image', 'tag', ...args]);
    case 'rmi':
      return passthrough(['image', 'delete', ...splitOptions('rmi', args).rest]);
    default:
      return fail(`docker-shim: '${command ?? ''}' is not supported by the Apple container docker shim`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => process.exit(fail(`docker-shim: ${(err as Error).stack ?? err}`)),
  );
}
