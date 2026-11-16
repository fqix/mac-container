// Helpers for the `container cluster` commands (Kubernetes clusters of container 1.7.1). No vscode dependency.

import * as path from 'path';

import {rm} from 'fs/promises';

import {CliError, ContainerCli} from './cli';
import type {KubeTarget} from './kubectl';

/** Expands a leading ~ to the home directory */
export function expandHome(file: string, home: string): string {
  return file === '~' || file.startsWith('~/')
    ? path.join(home, file.slice(1))
    : file;
}

/**
 * The kubeconfig `cluster create` / `delete` / `write-config` write to: the configured file if any, else what the CLI
 * picks from KUBECONFIG (ClusterHelper+Kubeconfig.swift, resolveKubeconfigMergePath): a single entry as is, of
 * several the first that exists or else the last one, and ~/.kube/config without KUBECONFIG.
 */
export function resolveKubeconfig(
  configured: string,
  envKubeconfig: string | undefined,
  home: string,
  exists: (file: string) => boolean,
): string {
  const setting = configured.trim();
  if (setting) {
    return expandHome(setting, home);
  }
  const paths = (envKubeconfig ?? '').split(':').filter(Boolean);
  if (paths.length === 0) {
    return path.join(home, '.kube', 'config');
  }
  if (paths.length === 1) {
    return paths[0];
  }
  return paths.find(exists) ?? paths[paths.length - 1];
}

/** Environment for the cluster commands: KUBECONFIG only when the setting overrides the CLI's own choice */
export function clusterEnv(
  configured: string,
  home: string,
): Record<string, string> | undefined {
  const setting = configured.trim();
  return setting ? {KUBECONFIG: expandHome(setting, home)} : undefined;
}

/** The CLI predates clusters (before 1.7.1): ArgumentParser rejects the subcommand */
export function isClusterUnsupported(error: unknown): boolean {
  return (
    error instanceof CliError &&
    /unknown (sub)?command/i.test(error.stderr) &&
    /cluster/.test(error.stderr)
  );
}

/** Node names become container names and hostnames (<name>-worker-<n>), so keep to DNS labels */
export function isValidClusterName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/.test(name);
}

/** `--shared-image-store` needs this helper, which some builds leave out (Homebrew's container 1.7.1) */
export function clusterShimPath(installRoot: string): string {
  return path.join(
    installRoot,
    'libexec',
    'container',
    'plugins',
    'cluster',
    'resources',
    'cluster-shim',
  );
}

export interface ClusterCreateOptions {
  name: string;
  workers: number;
  sharedImageStore: boolean;
}

export function clusterCreateArgs(options: ClusterCreateOptions): string[] {
  return [
    'cluster',
    'create',
    '--name',
    options.name,
    ...(options.workers > 0 ? ['--workers', String(options.workers)] : []),
    ...(options.sharedImageStore ? ['--shared-image-store'] : []),
  ];
}

/** `container cluster write-config` arguments writing the context of `cluster` to `kubeconfig` */
export function writeConfigArgs(cluster: string, kubeconfig: string): string[] {
  return [
    'cluster',
    'write-config',
    '--name',
    cluster,
    '--kubeconfig',
    kubeconfig,
  ];
}

/**
 * Kubeconfigs the extension writes for itself, one file per cluster under `dir`, so browsing a cluster never reads or
 * changes the user's kubeconfig. Each file is written once per session with `cluster write-config`; the context is
 * named after the cluster.
 */
export class ClusterKubeconfigs {
  private readonly written = new Map<string, Promise<KubeTarget>>();

  constructor(
    private readonly cli: ContainerCli,
    private readonly dir: string,
  ) {}

  file(cluster: string): string {
    return path.join(this.dir, `${cluster}.yaml`);
  }

  target(cluster: string): Promise<KubeTarget> {
    let pending = this.written.get(cluster);
    if (!pending) {
      const kubeconfig = this.file(cluster);
      const write = this.cli
        .run(writeConfigArgs(cluster, kubeconfig))
        .then(() => ({kubeconfig, context: cluster}));
      // A failed write is retried on the next call, unless a newer write replaced it meanwhile
      write.catch(() => {
        if (this.written.get(cluster) === write) {
          this.written.delete(cluster);
        }
      });
      this.written.set(cluster, write);
      pending = write;
    }
    return pending;
  }

  /** Written again on next use, e.g. after the cluster was recreated with new certificates */
  invalidate(cluster: string): void {
    this.written.delete(cluster);
  }

  async remove(cluster: string): Promise<void> {
    this.written.delete(cluster);
    await rm(this.file(cluster), {force: true});
  }
}
