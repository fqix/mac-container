// kubectl for the Kubernetes clusters of `container cluster`: locating, downloading and running it. No vscode dependency.

import {execFile} from 'child_process';
import {createHash} from 'crypto';
import {createWriteStream} from 'fs';
import {chmod, mkdir, readdir, rename, rm} from 'fs/promises';
import * as https from 'https';
import * as path from 'path';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export class KubectlError extends Error {
  /** Exit code of kubectl; for `kubectl exec` that of the command in the container */
  readonly exitCode: number | string | undefined;

  constructor(
    readonly args: string[],
    readonly stderr: string,
    options?: {cause?: unknown; exitCode?: number | string},
  ) {
    const reason =
      stderr
        .split('\n')
        .map(l => l.trim())
        .find(Boolean)
        ?.replace(/^error:\s*/i, '') ?? 'failed';
    super(`kubectl ${args.join(' ')}: ${reason}`, options);
    this.name = 'KubectlError';
    this.exitCode = options?.exitCode;
  }
}

/**
 * Runs kubectl with execFile (no shell) and resolves with its stdout. `shown` is what errors name as the command, so
 * they leave out the kubeconfig arguments.
 */
export function runProcess(
  executable: string,
  args: string[],
  options: {timeoutMs?: number; input?: string; shown?: string[]} = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      {timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER},
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new KubectlError(options.shown ?? args, stderr || error.message, {
              cause: error,
              exitCode: (error as {code?: number | string}).code,
            }),
          );
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

/** Which cluster a kubectl call talks to: an extension-owned kubeconfig with one context per cluster */
export interface KubeTarget {
  kubeconfig: string;
  context: string;
}

export function kubectlArgs(target: KubeTarget, args: string[]): string[] {
  return [
    '--kubeconfig',
    target.kubeconfig,
    '--context',
    target.context,
    ...args,
  ];
}

/** Runs kubectl with execFile (no shell) against one cluster */
export function runKubectl(
  executable: string,
  target: KubeTarget,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  /** Written to stdin, e.g. the manifest for `apply -f -` */
  input?: string,
): Promise<string> {
  return runProcess(
    executable,
    kubectlArgs(target, ['--request-timeout=15s', ...args]),
    {timeoutMs, input, shown: args},
  );
}

const VERSION = /^v\d+\.\d+\.\d+$/;

export function isKubernetesVersion(version: string): boolean {
  return VERSION.test(version);
}

/** The Apple silicon kubectl of a release on dl.k8s.io; its checksum is at the same URL plus .sha256 */
export function kubectlDownloadUrl(version: string): string {
  if (!isKubernetesVersion(version)) {
    throw new Error(`Not a Kubernetes release: ${version}`);
  }
  return `https://dl.k8s.io/release/${version}/bin/darwin/arm64/kubectl`;
}

/** Where a downloaded kubectl lives: <dir>/<version>/kubectl */
export function downloadedKubectlPath(dir: string, version: string): string {
  return path.join(dir, version, 'kubectl');
}

/** Downloaded versions under `dir`, newest first */
export async function downloadedKubectlVersions(
  dir: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const parts = (v: string) => v.slice(1).split('.').map(Number);
  return names.filter(isKubernetesVersion).sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
}

/** GET with redirects; resolves with the response stream */
function get(
  url: string,
  redirects = 5,
): Promise<import('http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    https
      .get(url, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects <= 0) {
            reject(new Error(`Too many redirects: ${url}`));
            return;
          }
          resolve(
            get(
              new URL(response.headers.location, url).toString(),
              redirects - 1,
            ),
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`GET ${url}: HTTP ${status}`));
          return;
        }
        resolve(response);
      })
      .on('error', reject);
  });
}

export async function fetchText(url: string): Promise<string> {
  const response = await get(url);
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The checksum file holds the hex digest, optionally followed by a file name */
export function parseSha256(text: string): string {
  const digest = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Invalid kubectl checksum file');
  }
  return digest;
}

/**
 * Downloads kubectl `version` into `dir`, checks it against the published SHA-256 and makes it executable. The file
 * only appears at its final path once verified.
 */
export async function downloadKubectl(
  dir: string,
  version: string,
  onProgress?: (received: number, total: number | undefined) => void,
): Promise<string> {
  const url = kubectlDownloadUrl(version);
  const expected = parseSha256(await fetchText(`${url}.sha256`));
  const target = downloadedKubectlPath(dir, version);
  await mkdir(path.dirname(target), {recursive: true});
  const partial = `${target}.download`;
  try {
    const response = await get(url);
    const total = Number(response.headers['content-length']) || undefined;
    const hash = createHash('sha256');
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(partial, {mode: 0o755});
      response.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        onProgress?.(received, total);
      });
      response.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      response.pipe(out);
    });
    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new Error(
        `kubectl ${version} checksum mismatch: expected ${expected}, got ${actual}`,
      );
    }
    await chmod(partial, 0o755);
    await rename(partial, target);
    return target;
  } finally {
    await rm(partial, {force: true});
  }
}
