// Kubernetes objects of a cluster: create and apply, YAML, describe, delete, pod logs and shell, rollout restart and
// scale, and the namespace the view lists (via kubectl)

import * as vscode from 'vscode';

import {kindOf} from '../services/k8s';
import {
  hasTemplate,
  k8sTemplate,
  TEMPLATE_RESOURCES,
  TemplateResource,
} from '../services/k8sTemplates';
import {kubectlArgs} from '../services/kubectl';
import {openTerminal} from '../ui/terminal';
import {KindNode, SectionNode} from '../views/clusters';
import type {
  ClusterNodeTreeNode,
  K8sItemTreeNode,
  K8sRef,
} from '../views/clusters';
import {ask, CommandContext, confirm, register, withProgress} from './common';
import {logTail} from './containers';

/** What a command acts on: a Kubernetes object row, or a cluster node row (its Kubernetes Node) */
interface Target {
  cluster: string;
  version?: string;
  resource: string;
  name: string;
  namespace?: string;
  containers?: string[];
}

function targetOf(
  node: K8sItemTreeNode | ClusterNodeTreeNode | undefined,
): Target | undefined {
  if (!node) {
    return undefined;
  }
  const resource = node.resource as K8sRef | ClusterNodeTreeNode['resource'];
  if ('item' in resource) {
    return {
      cluster: resource.cluster,
      version: resource.version,
      resource: resource.item.resource,
      name: resource.item.name,
      namespace: resource.item.namespace,
      containers: resource.item.containers,
    };
  }
  return {
    cluster: resource.cluster,
    version: resource.version,
    resource: 'nodes',
    name: resource.node.name,
  };
}

const namespaceArgs = (target: Target) =>
  target.namespace ? ['--namespace', target.namespace] : [];

/** `kind/name` in the namespace, for titles and confirmations */
const display = (target: Target) =>
  `${kindOf(target.resource)?.label ?? target.resource}/${target.namespace ? `${target.namespace}/` : ''}${target.name}`;

export function registerK8sCommands(ctx: CommandContext): void {
  const {k8s} = ctx;
  const changed = () => {
    ctx.views.clusters.clearCache();
    ctx.views.clusters.refresh();
  };
  const interactive = (target: Target) => ({
    interactive: true,
    version: target.version,
  });

  /** Container of the pod to attach to: the only one, or picked */
  const pickContainer = async (target: Target) => {
    const containers = target.containers ?? [];
    if (containers.length <= 1) {
      return containers[0];
    }
    return vscode.window.showQuickPick(containers, {
      title: display(target),
      placeHolder: vscode.l10n.t('Container'),
    });
  };

  /** Untitled manifests opened by New Resource, and the cluster each was opened for */
  const drafts = new Map<string, string>();
  ctx.extension.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc =>
      drafts.delete(doc.uri.toString()),
    ),
  );

  register(ctx, 'appleContainer.k8s.switchNamespace', async () => {
    const view = ctx.views.clusters;
    if (!view.current) {
      return;
    }
    const current = view.namespace;
    const names = await withProgress(
      vscode.l10n.t('Reading namespaces...'),
      () => view.namespaces(),
    );
    const items = [
      {
        label: vscode.l10n.t('All Namespaces'),
        namespace: undefined as string | undefined,
      },
      ...names.map(name => ({label: name, namespace: name})),
    ].map(item => ({
      ...item,
      iconPath: new vscode.ThemeIcon(
        item.namespace === current ? 'check' : 'blank',
      ),
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Switch Namespace'),
      placeHolder: view.current.name,
    });
    if (picked) {
      await view.selectNamespace(picked.namespace);
    }
  });

  register(
    ctx,
    'appleContainer.k8s.create',
    async (node?: KindNode | SectionNode) => {
      const cluster = ctx.views.clusters.current;
      if (!cluster) {
        return;
      }
      // From a kind folder (or the Namespaces section) that kind, else picked
      let resource: string | undefined =
        node instanceof KindNode
          ? node.kind.resource
          : node instanceof SectionNode && node.section === 'namespaces'
            ? 'namespaces'
            : undefined;
      if (!resource || !hasTemplate(resource)) {
        const picked = await vscode.window.showQuickPick(
          [
            ...TEMPLATE_RESOURCES.map(r => ({
              label: kindOf(r)?.label ?? r,
              resource: r as TemplateResource | undefined,
            })),
            {label: vscode.l10n.t('Blank'), resource: undefined},
          ],
          {
            title: vscode.l10n.t('New Resource in {0}', cluster.name),
            placeHolder: vscode.l10n.t('Kind'),
          },
        );
        if (!picked) {
          return;
        }
        resource = picked.resource;
      }
      const content =
        resource && hasTemplate(resource)
          ? k8sTemplate(resource, ctx.views.clusters.namespace ?? 'default')
          : 'apiVersion: v1\nkind: \nmetadata:\n  name: \n';
      const doc = await vscode.workspace.openTextDocument({
        language: 'yaml',
        content,
      });
      drafts.set(doc.uri.toString(), cluster.name);
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Edit the manifest, then use Apply to Cluster in the editor title to create it in {0}.',
          cluster.name,
        ),
      );
    },
  );

  register(ctx, 'appleContainer.k8s.apply', async (uri?: vscode.Uri) => {
    const doc = uri
      ? await vscode.workspace.openTextDocument(uri)
      : vscode.window.activeTextEditor?.document;
    if (!doc) {
      return;
    }
    const name =
      drafts.get(doc.uri.toString()) ?? ctx.views.clusters.current?.name;
    const cluster = ctx.views.clusters.clusters.find(c => c.name === name);
    if (!cluster) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Select a cluster in the Kubernetes view first.'),
      );
      return;
    }
    const manifest = doc.getText();
    if (!manifest.trim()) {
      return;
    }
    const apply = vscode.l10n.t('Apply');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Apply {0} to cluster {1}?', doc.fileName, cluster.name),
      {
        modal: true,
        detail: vscode.l10n.t(
          'kubectl apply creates or updates the objects in the manifest.',
        ),
      },
      apply,
    );
    if (answer !== apply) {
      return;
    }
    const out = await withProgress(
      vscode.l10n.t('Applying to {0}...', cluster.name),
      () =>
        k8s.run(cluster.name, ['apply', '-f', '-'], {
          interactive: true,
          version: cluster.kubernetesVersion,
          input: manifest,
        }),
    );
    void vscode.window.showInformationMessage(
      out.trim().split('\n').slice(-3).join(' ') ||
        vscode.l10n.t('Applied to {0}.', cluster.name),
    );
    changed();
  });

  register(ctx, 'appleContainer.kubectl.download', async (version?: string) => {
    if (await k8s.ensure(version)) {
      changed();
    }
  });

  register(
    ctx,
    'appleContainer.k8s.yaml',
    async (node?: K8sItemTreeNode | ClusterNodeTreeNode) => {
      const target = targetOf(node);
      if (!target) {
        return;
      }
      await ctx.documents.open(
        `/k8s/${target.cluster}/${target.resource}/${target.namespace ?? '_'}/${target.name}.yaml`,
        () =>
          k8s.run(
            target.cluster,
            [
              'get',
              target.resource,
              target.name,
              ...namespaceArgs(target),
              '-o',
              'yaml',
            ],
            interactive(target),
          ),
        'yaml',
      );
    },
  );

  register(
    ctx,
    'appleContainer.k8s.describe',
    async (node?: K8sItemTreeNode | ClusterNodeTreeNode) => {
      const target = targetOf(node);
      if (!target) {
        return;
      }
      await ctx.documents.open(
        `/k8s/${target.cluster}/${target.resource}/${target.namespace ?? '_'}/${target.name}.describe`,
        () =>
          k8s.run(
            target.cluster,
            [
              'describe',
              target.resource,
              target.name,
              ...namespaceArgs(target),
            ],
            interactive(target),
          ),
        'plaintext',
      );
    },
  );

  register(ctx, 'appleContainer.k8s.delete', async (node?: K8sItemTreeNode) => {
    const target = targetOf(node);
    if (!target) {
      return;
    }
    if (
      !(await confirm(
        vscode.l10n.t('Delete {0}?', display(target)),
        vscode.l10n.t('Delete'),
        vscode.l10n.t('Cluster: {0}', target.cluster),
      ))
    ) {
      return;
    }
    await withProgress(vscode.l10n.t('Deleting {0}...', display(target)), () =>
      k8s.run(
        target.cluster,
        [
          'delete',
          target.resource,
          target.name,
          ...namespaceArgs(target),
          '--wait=false',
        ],
        interactive(target),
      ),
    );
    changed();
  });

  register(ctx, 'appleContainer.k8s.logs', async (node?: K8sItemTreeNode) => {
    const target = targetOf(node);
    if (!target) {
      return;
    }
    const container = await pickContainer(target);
    if ((target.containers?.length ?? 0) > 1 && !container) {
      return;
    }
    const {kubectl, target: kube} = await k8s.prepare(
      target.cluster,
      interactive(target),
    );
    const tail = logTail();
    openTerminal(
      vscode.l10n.t(
        'Logs: {0}',
        container ? `${target.name}/${container}` : target.name,
      ),
      kubectl,
      kubectlArgs(kube, [
        'logs',
        '--follow',
        ...(tail > 0 ? ['--tail', String(tail)] : []),
        ...namespaceArgs(target),
        target.name,
        ...(container ? ['--container', container] : []),
      ]),
      'output',
    );
  });

  register(ctx, 'appleContainer.k8s.shell', async (node?: K8sItemTreeNode) => {
    const target = targetOf(node);
    if (!target) {
      return;
    }
    const container = await pickContainer(target);
    if ((target.containers?.length ?? 0) > 1 && !container) {
      return;
    }
    const {kubectl, target: kube} = await k8s.prepare(
      target.cluster,
      interactive(target),
    );
    // bash when the image has it, else sh
    openTerminal(
      `${container ? `${target.name}/${container}` : target.name}: shell`,
      kubectl,
      kubectlArgs(kube, [
        'exec',
        '--stdin',
        '--tty',
        ...namespaceArgs(target),
        target.name,
        ...(container ? ['--container', container] : []),
        '--',
        'sh',
        '-c',
        'command -v bash >/dev/null 2>&1 && exec bash || exec sh',
      ]),
      'terminal',
    );
  });

  register(
    ctx,
    'appleContainer.k8s.restart',
    async (node?: K8sItemTreeNode) => {
      const target = targetOf(node);
      if (!target) {
        return;
      }
      if (
        !(await confirm(
          vscode.l10n.t('Restart {0}?', display(target)),
          vscode.l10n.t('Restart'),
          vscode.l10n.t('Its pods are replaced one by one (rollout restart).'),
        ))
      ) {
        return;
      }
      await k8s.run(
        target.cluster,
        [
          'rollout',
          'restart',
          `${target.resource}/${target.name}`,
          ...namespaceArgs(target),
        ],
        interactive(target),
      );
      changed();
    },
  );

  register(ctx, 'appleContainer.k8s.scale', async (node?: K8sItemTreeNode) => {
    const target = targetOf(node);
    if (!target) {
      return;
    }
    const current = node?.resource.item.status?.split('/')[1];
    const replicas = await ask({
      title: vscode.l10n.t('Scale {0}', display(target)),
      prompt: vscode.l10n.t('Number of replicas'),
      value: current,
      validateInput: v =>
        /^\d+$/.test(v.trim()) && Number(v) <= 1000
          ? undefined
          : vscode.l10n.t('Enter a whole number from 0 to 1000'),
    });
    if (replicas === undefined) {
      return;
    }
    await k8s.run(
      target.cluster,
      [
        'scale',
        `${target.resource}/${target.name}`,
        ...namespaceArgs(target),
        `--replicas=${replicas}`,
      ],
      interactive(target),
    );
    changed();
  });
}
