// Kubernetes clusters of `container cluster` (container 1.7.1) and their nodes, which are containers

import {existsSync} from 'fs';
import * as os from 'os';

import * as vscode from 'vscode';

import {StatsPanel} from '../panels/statsPanel';
import {
  clusterCreateArgs,
  clusterEnv,
  clusterShimPath,
  isValidClusterName,
  resolveKubeconfig,
} from '../services/cluster';
import {relativeTime} from '../utils/i18n';
import {parseJson} from '../utils/parse';
import {runTask} from '../ui/terminal';
import type {ClusterNodeTreeNode} from '../views/clusters';
import {ask, CommandContext, confirm, register, withProgress} from './common';
import {followLogs, openShell} from './containers';

const configuredKubeconfig = () =>
  vscode.workspace
    .getConfiguration('appleContainer')
    .get<string>('cluster.kubeconfig', '');

/** The kubeconfig the CLI writes to and the environment that makes it do so */
function kubeconfigTarget(): {
  file: string;
  env: Record<string, string> | undefined;
} {
  const configured = configuredKubeconfig();
  return {
    file: resolveKubeconfig(
      configured,
      process.env.KUBECONFIG,
      os.homedir(),
      existsSync,
    ),
    env: clusterEnv(configured, os.homedir()),
  };
}

export function registerClusterCommands(ctx: CommandContext): void {
  const {cli} = ctx;
  const refresh = () => {
    ctx.views.clusters.clearCache();
    ctx.views.clusters.refresh();
  };

  register(ctx, 'appleContainer.cluster.create', async () => {
    const title = vscode.l10n.t('Create Kubernetes Cluster');
    const existing = new Set(
      (await cli.listClusters()).map(cluster => cluster.name),
    );
    const name = await ask({
      title,
      prompt: vscode.l10n.t(
        'Cluster name, also the kubeconfig context and the prefix of the node containers',
      ),
      value: existing.has('cluster-dev') ? '' : 'cluster-dev',
      validateInput: value => {
        const trimmed = value.trim();
        if (!isValidClusterName(trimmed)) {
          return vscode.l10n.t(
            'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit',
          );
        }
        return existing.has(trimmed)
          ? vscode.l10n.t('A cluster named {0} already exists', trimmed)
          : undefined;
      },
    });
    if (!name) {
      return;
    }
    const workerItems = [0, 1, 2, 3].map(count => ({
      label:
        count === 0
          ? vscode.l10n.t('Single node')
          : vscode.l10n.t('{0} worker(s)', String(count)),
      description:
        count === 0
          ? vscode.l10n.t('The control plane also runs workloads')
          : undefined,
      count,
    }));
    const workers = await vscode.window.showQuickPick(workerItems, {
      title,
      placeHolder: vscode.l10n.t('Worker nodes besides the control plane'),
    });
    if (!workers) {
      return;
    }
    // --shared-image-store fails right away when this build lacks cluster-shim (Homebrew's 1.7.1), so only offer it
    // when the helper is there
    const {installRoot} = await cli.systemStatus();
    let sharedImageStore = false;
    if (!installRoot || existsSync(clusterShimPath(installRoot))) {
      const shared = {
        label: vscode.l10n.t('Share the local image store'),
        detail: vscode.l10n.t(
          'Nodes can run images built or pulled with container without pushing them to a registry',
        ),
      };
      const options = await vscode.window.showQuickPick([shared], {
        title,
        canPickMany: true,
        placeHolder: vscode.l10n.t(
          'Options (press Enter to keep the defaults)',
        ),
      });
      if (!options) {
        return;
      }
      sharedImageStore = options.includes(shared);
    }
    const {file, env} = kubeconfigTarget();
    // A cluster of the same name may have existed before, with other certificates
    ctx.k8s.kubeconfigs.invalidate(name);
    const exitCode = await runTask(
      vscode.l10n.t('Create cluster {0}', name),
      await cli.executable(),
      clusterCreateArgs({
        name,
        workers: workers.count,
        sharedImageStore,
      }),
      undefined,
      env,
    );
    if (exitCode === 0) {
      await ctx.views.clusters.select(name);
    }
    refresh();
    if (exitCode === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Cluster {0} is ready. Its context {0} was written to {1}.',
          name,
          file,
        ),
      );
    }
  });

  register(ctx, 'appleContainer.cluster.switch', async () => {
    const provider = ctx.views.clusters;
    // The view's last listing (sorted, kept fresh by polling); list only when the view has not listed yet
    const clusters = provider.clusters.length
      ? provider.clusters
      : (await cli.listClusters()).sort((a, b) => a.name.localeCompare(b.name));
    const items = clusters.map(cluster => ({
      label: cluster.name,
      description: [
        cluster.state,
        cluster.kubernetesVersion,
        vscode.l10n.t('{0} nodes', String(cluster.nodes.length)),
      ]
        .filter(Boolean)
        .join(' · '),
      detail: [
        relativeTime(cluster.createdAt),
        `${vscode.l10n.t('Shared image store')}: ${cluster.sharedImageStore ? vscode.l10n.t('Yes') : vscode.l10n.t('No')}`,
        cluster.cni ? `${vscode.l10n.t('CNI')}: ${cluster.cni}` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      iconPath: new vscode.ThemeIcon(
        cluster.name === provider.current?.name ? 'check' : 'blank',
      ),
      cluster,
    }));
    const create = {
      label: `$(add) ${vscode.l10n.t('Create Kubernetes Cluster...')}`,
      description: '',
      cluster: undefined,
    };
    const picked = await vscode.window.showQuickPick([...items, create], {
      title: vscode.l10n.t('Switch Cluster'),
      placeHolder: vscode.l10n.t('Cluster to show'),
    });
    if (!picked) {
      return;
    }
    if (!picked.cluster) {
      await vscode.commands.executeCommand('appleContainer.cluster.create');
      return;
    }
    await provider.select(picked.cluster.name);
  });

  register(ctx, 'appleContainer.cluster.delete', async () => {
    const cluster = ctx.views.clusters.current;
    if (!cluster) {
      return;
    }
    const name = cluster.name;
    const {file, env} = kubeconfigTarget();
    if (
      !(await confirm(
        vscode.l10n.t('Delete cluster {0}?', name),
        vscode.l10n.t('Delete'),
        vscode.l10n.t(
          'Its {0} node containers are deleted, and the context {1} is removed from {2}.',
          String(cluster.nodes.length),
          name,
          file,
        ),
      ))
    ) {
      return;
    }
    await withProgress(vscode.l10n.t('Deleting {0}...', name), () =>
      cli.run(['cluster', 'delete', '--name', name], {
        env,
        timeoutMs: 300_000,
      }),
    );
    await ctx.k8s.kubeconfigs.remove(name);
    refresh();
  });

  register(ctx, 'appleContainer.cluster.writeConfig', async () => {
    const name = ctx.views.clusters.current?.name;
    if (!name) {
      return;
    }
    const {file} = kubeconfigTarget();
    const toDefault = {
      label: vscode.l10n.t('Write to {0}', file),
      description: vscode.l10n.t('Merged; replaces the context {0}', name),
    };
    const toOther = {label: vscode.l10n.t('Save to Another File...')};
    const choice = await vscode.window.showQuickPick([toDefault, toOther], {
      title: vscode.l10n.t('Write Kubeconfig for {0}', name),
    });
    if (!choice) {
      return;
    }
    let target = file;
    if (choice === toOther) {
      const picked = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${os.homedir()}/.kube/${name}.kubeconfig`),
        title: vscode.l10n.t('Write Kubeconfig for {0}', name),
      });
      if (!picked) {
        return;
      }
      target = picked.fsPath;
    }
    // Always explicit, so the file shown is the file written whatever KUBECONFIG says
    await cli.run([
      'cluster',
      'write-config',
      '--name',
      name,
      '--kubeconfig',
      target,
    ]);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Context {0} was written to {1}.', name, target),
    );
  });

  register(ctx, 'appleContainer.cluster.copyContext', async () => {
    const name = ctx.views.clusters.current?.name;
    if (name) {
      await vscode.env.clipboard.writeText(name);
    }
  });

  register(ctx, 'appleContainer.cluster.inspect', async () => {
    const name = ctx.views.clusters.current?.name;
    if (!name) {
      return;
    }
    // There is no `cluster inspect`; show this cluster's entry of the list output
    await ctx.documents.open(`/cluster/${name}.json`, async () => {
      const list = parseJson(
        await cli.run(['cluster', 'list', '--format', 'json']),
      );
      const entry = Array.isArray(list)
        ? list.find(
            item => item?.id === name || item?.configuration?.name === name,
          )
        : undefined;
      return JSON.stringify(entry ?? null, null, 2);
    });
  });

  register(
    ctx,
    'appleContainer.clusterNode.exec',
    async (node?: ClusterNodeTreeNode) => {
      if (node) {
        await openShell(cli, node.resource.node.name);
      }
    },
  );

  register(
    ctx,
    'appleContainer.clusterNode.logs',
    async (node?: ClusterNodeTreeNode) => {
      if (node) {
        await followLogs(cli, node.resource.node.name);
      }
    },
  );

  register(
    ctx,
    'appleContainer.clusterNode.stats',
    (node?: ClusterNodeTreeNode) => {
      if (node) {
        StatsPanel.show(
          ctx.extension.extensionUri,
          cli,
          node.resource.node.name,
        );
      }
    },
  );

  register(
    ctx,
    'appleContainer.clusterNode.inspect',
    async (node?: ClusterNodeTreeNode) => {
      if (node) {
        const name = node.resource.node.name;
        await ctx.documents.open(`/container/${name}.json`, () =>
          cli.inspect('container', [name]),
        );
      }
    },
  );

  register(
    ctx,
    'appleContainer.clusterNode.copyIp',
    async (node?: ClusterNodeTreeNode) => {
      const ip = node?.resource.node.addresses[0];
      if (ip) {
        await vscode.env.clipboard.writeText(ip.replace(/\/\d+$/, ''));
      } else {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('This container has no IP address.'),
        );
      }
    },
  );
}
