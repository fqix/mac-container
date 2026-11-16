// kubectl for browsing clusters: found in the settings or PATH, else downloaded on the user's consent

import {access, constants} from 'fs/promises';
import * as path from 'path';

import * as vscode from 'vscode';

import {ContainerCli, resolveCliPath} from '../services/cli';
import {ClusterKubeconfigs} from '../services/cluster';
import {
  downloadKubectl,
  downloadedKubectlPath,
  downloadedKubectlVersions,
  fetchText,
  isKubernetesVersion,
  KubectlError,
  KubeTarget,
  runKubectl,
} from '../services/kubectl';

/** Thrown when no kubectl is available and none may be downloaded without asking */
export class KubectlMissingError extends Error {
  constructor() {
    super(vscode.l10n.t('kubectl was not found.'));
    this.name = 'KubectlMissingError';
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Errors after which the cluster's kubeconfig is written again: the cluster may have been recreated */
function isConnectionError(error: unknown): boolean {
  return (
    error instanceof KubectlError &&
    /Unable to connect|x509|certificate|Unauthorized|connection refused/i.test(
      error.stderr,
    )
  );
}

export class K8sAccess {
  readonly kubeconfigs: ClusterKubeconfigs;
  private readonly downloadDir: string;
  private downloading: Promise<string | undefined> | undefined;
  /** The kubectl find() resolved, and for which appleContainer.kubectlPath */
  private found: {configured: string; file: string} | undefined;

  constructor(cli: ContainerCli, storageDir: string) {
    this.kubeconfigs = new ClusterKubeconfigs(
      cli,
      path.join(storageDir, 'kubeconfig'),
    );
    this.downloadDir = path.join(storageDir, 'kubectl');
  }

  /**
   * appleContainer.kubectlPath if it resolves, else kubectl on PATH / Homebrew, else the newest downloaded one. The
   * result is kept until the setting changes or running it fails with ENOENT, so tree refreshes do not scan PATH.
   */
  async find(): Promise<string | undefined> {
    const configured = vscode.workspace
      .getConfiguration('appleContainer')
      .get<string>('kubectlPath', '')
      .trim();
    if (this.found?.configured === configured) {
      return this.found.file;
    }
    // A setting that does not resolve falls back, so a kubectl downloaded after asking is still used
    let file = configured ? await resolveCliPath(configured) : undefined;
    file ??= await resolveCliPath('kubectl');
    if (!file) {
      for (const version of await downloadedKubectlVersions(this.downloadDir)) {
        const candidate = downloadedKubectlPath(this.downloadDir, version);
        if (await isExecutable(candidate)) {
          file = candidate;
          break;
        }
      }
    }
    this.found = file ? {configured, file} : undefined;
    return file;
  }

  /**
   * kubectl, downloading it after asking when there is none. `version` is the cluster's Kubernetes version, so the
   * download matches the cluster; without one the current stable release is used.
   */
  async ensure(version?: string): Promise<string | undefined> {
    const found = await this.find();
    if (found) {
      return found;
    }
    this.downloading ??= this.download(version).finally(() => {
      this.downloading = undefined;
    });
    return this.downloading;
  }

  private async download(version?: string): Promise<string | undefined> {
    const download = vscode.l10n.t('Download');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('kubectl was not found.'),
      {
        modal: true,
        detail: vscode.l10n.t(
          'Download kubectl {0} for Apple silicon (about 55 MB) from dl.k8s.io? It is checked against the published SHA-256 and kept in the extension storage. To use another kubectl, set appleContainer.kubectlPath.',
          version && isKubernetesVersion(version)
            ? version
            : vscode.l10n.t('(latest stable)'),
        ),
      },
      download,
    );
    if (answer !== download) {
      return undefined;
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Downloading kubectl'),
      },
      async progress => {
        const release =
          version && isKubernetesVersion(version)
            ? version
            : (await fetchText('https://dl.k8s.io/release/stable.txt')).trim();
        let reported = 0;
        const file = await downloadKubectl(
          this.downloadDir,
          release,
          (received, total) => {
            if (!total) {
              return;
            }
            const percent = Math.floor((received / total) * 100);
            if (percent > reported) {
              progress.report({
                increment: percent - reported,
                message: `${release} ${percent}%`,
              });
              reported = percent;
            }
          },
        );
        void vscode.window.showInformationMessage(
          vscode.l10n.t('kubectl {0} was downloaded to {1}.', release, file),
        );
        this.found = undefined;
        return file;
      },
    );
  }

  /** kubectl and the cluster's kubeconfig; asks to download kubectl when `interactive` */
  async prepare(
    cluster: string,
    options: {interactive?: boolean; version?: string} = {},
  ): Promise<{kubectl: string; target: KubeTarget}> {
    const kubectl = options.interactive
      ? await this.ensure(options.version)
      : await this.find();
    if (!kubectl) {
      throw new KubectlMissingError();
    }
    return {kubectl, target: await this.kubeconfigs.target(cluster)};
  }

  async run(
    cluster: string,
    args: string[],
    options: {
      interactive?: boolean;
      version?: string;
      timeoutMs?: number;
      input?: string;
    } = {},
  ): Promise<string> {
    const {kubectl, target} = await this.prepare(cluster, options);
    try {
      return await runKubectl(
        kubectl,
        target,
        args,
        options.timeoutMs,
        options.input,
      );
    } catch (error) {
      if (isConnectionError(error)) {
        this.kubeconfigs.invalidate(cluster);
      }
      // kubectl was removed since it was found: look it up again next time
      if (error instanceof KubectlError && error.exitCode === 'ENOENT') {
        this.found = undefined;
      }
      throw error;
    }
  }

  async json(
    cluster: string,
    args: string[],
    options?: {interactive?: boolean; version?: string},
  ): Promise<unknown> {
    return JSON.parse(
      await this.run(cluster, [...args, '-o', 'json'], options),
    );
  }
}
