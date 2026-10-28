// container CLI wrapper: always invoked via execFile (no shell); handles path resolution, timeouts, errors and JSON parsing

import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import * as path from 'path';

import {
  parseContainers,
  parseImages,
  parseJson,
  parseNetworks,
  parseRegistries,
  parseStats,
  parseSystemStatus,
  parseVolumes,
} from '../utils/parse';
import type {
  ContainerStats,
  ContainerSummary,
  ImageSummary,
  NetworkSummary,
  RegistrySummary,
  SystemStatus,
  VolumeSummary,
} from '../models/types';

/** VS Code launched from the Dock does not inherit the shell PATH, so also look in Homebrew's and the official pkg's install locations */
const EXTRA_SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export class CliNotFoundError extends Error {
  constructor(readonly configuredPath: string) {
    super(`container CLI not found: ${configuredPath}`);
    this.name = 'CliNotFoundError';
  }
}

export class CliError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | string | undefined,
    readonly stderr: string,
    options?: { cause?: unknown },
  ) {
    super(`container ${args.join(' ')} failed: ${cliErrorDetail(stderr, exitCode)}`, options);
    this.name = 'CliError';
  }
}

/** Error reason: the first error line printed by the CLI, or the exit code if there is none */
export function cliErrorDetail(stderr: string, exitCode: number | string | undefined): string {
  return firstLine(stderr) || `exit ${exitCode}`;
}

function firstLine(text: string): string {
  // CLI errors usually start with "Error: "; take the first non-empty line
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.replace(/^Error:\s*/, '') ?? ''
  );
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the absolute path of the CLI executable; a configured value containing a path separator is used as is */
export async function resolveCliPath(configured: string, envPath = process.env.PATH ?? ''): Promise<string | undefined> {
  const value = configured.trim() || 'container';
  if (value.includes('/')) {
    return (await isExecutable(value)) ? value : undefined;
  }
  const dirs = [...envPath.split(path.delimiter).filter(Boolean), ...EXTRA_SEARCH_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, value);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Written to the process stdin, e.g. a password for --password-stdin */
  input?: string;
}

export class ContainerCli {
  private resolved: Promise<string | undefined> | undefined;

  constructor(private readonly getConfiguredPath: () => string) {}

  /** Call after the configuration changes so the path is resolved again on next use */
  reset(): void {
    this.resolved = undefined;
  }

  async executable(): Promise<string> {
    this.resolved ??= resolveCliPath(this.getConfiguredPath());
    const file = await this.resolved;
    if (!file) {
      this.resolved = undefined;
      throw new CliNotFoundError(this.getConfiguredPath());
    }
    return file;
  }

  async run(args: string[], options: RunOptions = {}): Promise<string> {
    const file = await this.executable();
    return new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, NO_COLOR: '1' } },
        (error, stdout, stderr) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              this.reset();
              reject(new CliNotFoundError(file));
              return;
            }
            reject(new CliError(args, (error as { code?: number | string }).code, stderr || stdout, { cause: error }));
            return;
          }
          resolve(stdout);
        },
      );
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    });
  }

  async json(args: string[], options?: RunOptions): Promise<unknown> {
    const out = await this.run([...args, '--format', 'json'], options);
    try {
      return parseJson(out);
    } catch (error) {
      throw new Error(`Failed to parse JSON output of container ${args.join(' ')}`, { cause: error });
    }
  }

  // ---- Queries ----

  async systemStatus(): Promise<SystemStatus> {
    try {
      return parseSystemStatus(await this.json(['system', 'status'], { timeoutMs: 10_000 }));
    } catch (error) {
      // system status exits non-zero when the service is not started; treat that as stopped
      if (error instanceof CliError) {
        return { running: false };
      }
      throw error;
    }
  }

  async listContainers(): Promise<ContainerSummary[]> {
    return parseContainers(await this.json(['list', '--all']));
  }

  async listImages(): Promise<ImageSummary[]> {
    return parseImages(await this.json(['image', 'list']));
  }

  async listNetworks(): Promise<NetworkSummary[]> {
    return parseNetworks(await this.json(['network', 'list']));
  }

  async listVolumes(): Promise<VolumeSummary[]> {
    return parseVolumes(await this.json(['volume', 'list']));
  }

  async listRegistries(): Promise<RegistrySummary[]> {
    return parseRegistries(await this.json(['registry', 'list']));
  }

  /** The password goes through stdin so it never shows up in the process list */
  async registryLogin(server: string, username: string, password: string): Promise<void> {
    await this.run(['registry', 'login', '--username', username, '--password-stdin', server], { input: password });
  }

  async stats(ids: string[]): Promise<ContainerStats[]> {
    return parseStats(await this.json(['stats', '--no-stream', ...ids]));
  }

  /** inspect commands print JSON natively and have no --format option */
  async inspect(kind: InspectKind, ids: string[]): Promise<string> {
    const prefix = kind === 'container' ? [] : [kind];
    const out = await this.run([...prefix, 'inspect', ...ids]);
    try {
      return JSON.stringify(parseJson(out), null, 2);
    } catch {
      return out;
    }
  }

  async systemDf(): Promise<unknown> {
    return this.json(['system', 'df']);
  }
}

export type InspectKind = 'container' | 'image' | 'network' | 'volume';
