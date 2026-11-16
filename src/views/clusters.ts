// Kubernetes clusters of `container cluster`, browsed like Lens: Nodes, Workloads, Config, Network, Storage,
// Namespaces and Events under each cluster. Cluster and node containers come from the container CLI, the rest from
// kubectl with an extension-owned kubeconfig.

import * as vscode from 'vscode';

import type {ContainerCli} from '../services/cli';
import {isClusterUnsupported} from '../services/cluster';
import {
  K8S_GROUPS,
  K8S_KINDS,
  K8sGroup,
  K8sItem,
  K8sKind,
  K8sLevel,
  K8sNodeInfo,
  parseK8sList,
  parseK8sNodes,
} from '../services/k8s';
import type {ServiceMonitor} from '../services/state';
import type {ClusterNode, ClusterSummary} from '../models/types';
import {describeError, relativeTime} from '../utils/i18n';
import {K8sAccess, KubectlMissingError} from '../ui/kubectl';
import {ResourceNode, ResourceProvider, TreeNode} from './base';

/** A node of a cluster: a container named after the node, which `container ls` does not list */
export interface ClusterNodeRef {
  cluster: string;
  /** Kubernetes version of the cluster, for a matching kubectl download */
  version?: string;
  node: ClusterNode;
  /** The Kubernetes Node of the same name, when kubectl could read it */
  k8s?: K8sNodeInfo;
}

export type ClusterNodeTreeNode = ResourceNode<ClusterNodeRef>;

/** A Kubernetes object in the tree */
export interface K8sRef {
  cluster: string;
  version?: string;
  item: K8sItem;
}

export type K8sItemTreeNode = ResourceNode<K8sRef>;

type Section = 'nodes' | K8sGroup;

export class SectionNode extends vscode.TreeItem {
  constructor(
    readonly cluster: ClusterSummary,
    readonly section: Section,
  ) {
    super(sectionLabel(section), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `cluster:${cluster.name}:${section}`;
    this.contextValue = `k8s.section.${section}`;
    this.iconPath = new vscode.ThemeIcon(SECTION_ICONS[section]);
  }
}

export class KindNode extends vscode.TreeItem {
  constructor(
    readonly cluster: ClusterSummary,
    readonly kind: K8sKind,
  ) {
    super(kind.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `cluster:${cluster.name}:kind:${kind.resource}`;
    this.contextValue = 'k8s.kind';
    this.iconPath = new vscode.ThemeIcon(kind.icon);
  }
}

/** An informational row, e.g. a kubectl error or the offer to download kubectl */
class InfoNode extends vscode.TreeItem {
  constructor(message: string, icon: string, command?: vscode.Command) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = message;
    this.command = command;
  }
}

const SECTION_ICONS: Record<Section, string> = {
  nodes: 'server',
  workloads: 'layers',
  config: 'settings-gear',
  network: 'globe',
  storage: 'database',
  namespaces: 'symbol-namespace',
  events: 'bell',
};

function sectionLabel(section: Section): string {
  switch (section) {
    case 'nodes':
      return vscode.l10n.t('Nodes');
    case 'workloads':
      return vscode.l10n.t('Workloads');
    case 'config':
      return vscode.l10n.t('Config');
    case 'network':
      return vscode.l10n.t('Network');
    case 'storage':
      return vscode.l10n.t('Storage');
    case 'namespaces':
      return vscode.l10n.t('Namespaces');
    case 'events':
      return vscode.l10n.t('Events');
  }
}

const LEVEL_COLORS: Record<K8sLevel, string | undefined> = {
  ok: 'testing.iconPassed',
  warn: 'problemsWarningIcon.foreground',
  error: 'problemsErrorIcon.foreground',
  none: undefined,
};

const running = (state: string | undefined) => state === 'running';

/** globalState key of the cluster the view shows */
const SELECTED_KEY = 'appleContainer.cluster.selected';
/** globalState key of the namespace shown per cluster; a missing entry shows all namespaces */
const NAMESPACES_KEY = 'appleContainer.cluster.namespaces';

/** kubectl lists are reused this long, so polling the view does not run kubectl for every open folder each time */
const CACHE_MS = 10_000;

export class ClustersProvider extends ResourceProvider<ClusterSummary> {
  private readonly cache = new Map<
    string,
    {time: number; value: Promise<unknown>}
  >();
  private listed: ClusterSummary[] = [];
  /** Set by rootNodes, to tell whether the last root listing reached it */
  private listedNow = false;
  private shown: ClusterSummary | undefined;
  private readonly shownEmitter = new vscode.EventEmitter<
    ClusterSummary | undefined
  >();
  /** Fires when the shown cluster, or its state, changes; the view title shows it */
  readonly onDidChangeCluster = this.shownEmitter.event;

  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
    private readonly k8s: K8sAccess,
    private readonly state: vscode.Memento,
  ) {
    super(monitor);
  }

  override dispose(): void {
    this.shownEmitter.dispose();
    super.dispose();
  }

  /** Drops cached kubectl output, e.g. for an explicit refresh or after a change */
  clearCache(): void {
    this.cache.clear();
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) {
      return hit.value as Promise<T>;
    }
    const value = load();
    this.cache.set(key, {time: Date.now(), value});
    // Failures are not cached; a newer load that replaced this one stays
    value.catch(() => {
      if (this.cache.get(key)?.value === value) {
        this.cache.delete(key);
      }
    });
    return value;
  }

  protected async fetch(): Promise<ClusterSummary[]> {
    try {
      return (await this.cli.listClusters()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch (error) {
      // A CLI without the cluster subcommand hides the view (package.json `when`)
      if (isClusterUnsupported(error)) {
        await vscode.commands.executeCommand(
          'setContext',
          'appleContainer.clustersUnsupported',
          true,
        );
        return [];
      }
      throw error;
    }
  }

  /** The cluster the view shows; the tree lists its sections, not the clusters */
  get current(): ClusterSummary | undefined {
    return this.shown;
  }

  /** All clusters of the last listing, for the switcher */
  get clusters(): ClusterSummary[] {
    return this.listed;
  }

  /** Shows `name` from now on, also in later sessions */
  async select(name: string): Promise<void> {
    await this.state.update(SELECTED_KEY, name);
    this.refresh();
  }

  /** Namespace the namespaced kinds are listed in for the shown cluster; undefined lists all namespaces */
  get namespace(): string | undefined {
    const name = this.shown?.name;
    return name
      ? this.state.get<Record<string, string>>(NAMESPACES_KEY, {})[name]
      : undefined;
  }

  /** Lists `namespace` (all namespaces when undefined) of the shown cluster from now on */
  async selectNamespace(namespace: string | undefined): Promise<void> {
    const name = this.shown?.name;
    if (!name) {
      return;
    }
    const all = {...this.state.get<Record<string, string>>(NAMESPACES_KEY, {})};
    if (namespace) {
      all[name] = namespace;
    } else {
      delete all[name];
    }
    await this.state.update(NAMESPACES_KEY, all);
    this.shownEmitter.fire(this.shown);
    this.clearCache();
    this.refresh();
  }

  /** Namespace names of the shown cluster, for the namespace switcher */
  async namespaces(): Promise<string[]> {
    const cluster = this.shown;
    if (!cluster) {
      return [];
    }
    const items = parseK8sList(
      'namespaces',
      await this.k8s.json(cluster.name, ['get', 'namespaces'], {
        interactive: true,
        version: cluster.kubernetesVersion,
      }),
    );
    return items.map(item => item.name);
  }

  override async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      return super.getChildren(element);
    }
    this.listedNow = false;
    const nodes = await super.getChildren();
    // The base skipped rootNodes (service stopped, CLI missing or a listing error): no cluster is shown, so the title
    // and the title bar actions do not act on a stale one
    if (!this.listedNow) {
      this.listed = [];
      this.setShown(undefined);
    }
    return nodes;
  }

  protected override rootNodes(clusters: ClusterSummary[]): TreeNode[] {
    this.listedNow = true;
    this.listed = clusters;
    const selected = this.state.get<string>(SELECTED_KEY);
    const cluster = clusters.find(c => c.name === selected) ?? clusters[0];
    this.setShown(cluster);
    if (!cluster) {
      // Empty: viewsWelcome offers to create one
      return [];
    }
    // Without a running cluster there is no API server, only its node containers
    const sections: Section[] = running(cluster.state)
      ? ['nodes', ...K8S_GROUPS]
      : ['nodes'];
    return sections.map(section => new SectionNode(cluster, section));
  }

  private setShown(cluster: ClusterSummary | undefined): void {
    const key = (c: ClusterSummary | undefined) =>
      c ? `${c.name}|${c.state}|${c.kubernetesVersion}|${c.nodes.length}` : '';
    if (key(cluster) === key(this.shown)) {
      return;
    }
    this.shown = cluster;
    void vscode.commands.executeCommand(
      'setContext',
      'appleContainer.hasCluster',
      !!cluster,
    );
    this.shownEmitter.fire(cluster);
  }

  protected override async childNodes(element: TreeNode): Promise<TreeNode[]> {
    if (element instanceof SectionNode) {
      const {cluster, section} = element;
      if (section === 'nodes') {
        return this.nodeItems(cluster);
      }
      const kinds = K8S_KINDS.filter(k => k.group === section);
      // Namespaces and Events have a single kind, listed directly like Lens does
      return kinds.length === 1
        ? this.kindItems(cluster, kinds[0])
        : kinds.map(kind => new KindNode(cluster, kind));
    }
    if (element instanceof KindNode) {
      return this.kindItems(element.cluster, element.kind);
    }
    return [];
  }

  private async nodeItems(cluster: ClusterSummary): Promise<TreeNode[]> {
    let k8sNodes: K8sNodeInfo[] = [];
    let problem: TreeNode | undefined;
    if (running(cluster.state)) {
      try {
        k8sNodes = await this.cached(`${cluster.name}/nodes`, async () =>
          parseK8sNodes(await this.k8s.json(cluster.name, ['get', 'nodes'])),
        );
      } catch (error) {
        problem = this.problemNode(cluster, error);
      }
    }
    const items = cluster.nodes.map(node =>
      this.nodeItem(
        cluster,
        node,
        k8sNodes.find(n => n.name === node.name),
      ),
    );
    return problem ? [...items, problem] : items;
  }

  private async kindItems(
    cluster: ClusterSummary,
    kind: K8sKind,
  ): Promise<TreeNode[]> {
    const namespace = kind.namespaced ? this.namespace : undefined;
    const scope = !kind.namespaced
      ? []
      : namespace
        ? ['--namespace', namespace]
        : ['--all-namespaces'];
    try {
      const items = await this.cached(
        `${cluster.name}/${kind.resource}/${namespace ?? '*'}`,
        async () =>
          parseK8sList(
            kind.resource,
            await this.k8s.json(cluster.name, ['get', kind.resource, ...scope]),
          ),
      );
      if (!items.length) {
        return [new InfoNode(vscode.l10n.t('None'), 'info')];
      }
      return items.map(item => this.itemNode(cluster, kind, item));
    } catch (error) {
      return [this.problemNode(cluster, error)];
    }
  }

  private problemNode(cluster: ClusterSummary, error: unknown): TreeNode {
    if (error instanceof KubectlMissingError) {
      return new InfoNode(
        vscode.l10n.t('kubectl was not found. Click to download it.'),
        'cloud-download',
        {
          title: vscode.l10n.t('Download kubectl'),
          command: 'appleContainer.kubectl.download',
          arguments: [cluster.kubernetesVersion],
        },
      );
    }
    const node = new InfoNode(describeError(error), 'error');
    node.iconPath = new vscode.ThemeIcon(
      'error',
      new vscode.ThemeColor('errorForeground'),
    );
    return node;
  }

  private itemNode(
    cluster: ClusterSummary,
    kind: K8sKind,
    item: K8sItem,
  ): K8sItemTreeNode {
    const isEvent = kind.resource === 'events';
    // With one namespace selected, repeating it on every row is noise
    const namespace = this.namespace ? undefined : item.namespace;
    // Events are read by reason and object, like Lens does; their own names are generated
    const node = new ResourceNode<K8sRef>(
      {cluster: cluster.name, version: cluster.kubernetesVersion, item},
      isEvent
        ? `${item.status ?? ''} ${item.details[0] ?? ''}`.trim()
        : item.name,
    );
    node.id = `cluster:${cluster.name}:${kind.resource}:${item.namespace ?? ''}/${item.name}`;
    node.contextValue = `k8s.item.${kind.resource}`;
    const color = LEVEL_COLORS[item.level];
    node.iconPath = new vscode.ThemeIcon(
      kind.icon,
      color ? new vscode.ThemeColor(color) : undefined,
    );
    node.description = (
      isEvent
        ? [namespace, ...item.details.slice(1), relativeTime(item.createdAt)]
        : [
            namespace,
            item.status,
            ...item.details.slice(0, 2),
            relativeTime(item.createdAt),
          ]
    )
      .filter(Boolean)
      .join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**').appendText(item.name).appendMarkdown('**\n\n');
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Kind'), kind.label],
      [vscode.l10n.t('Namespace'), item.namespace],
      [vscode.l10n.t('Status'), item.status],
      [vscode.l10n.t('Created'), relativeTime(item.createdAt)],
    ];
    for (const [k, v] of rows) {
      if (v) {
        md.appendMarkdown(`- ${k}: `).appendText(v).appendMarkdown('\n');
      }
    }
    for (const detail of item.details) {
      md.appendMarkdown('- ').appendText(detail).appendMarkdown('\n');
    }
    node.tooltip = md;
    return node;
  }

  private nodeItem(
    cluster: ClusterSummary,
    node: ClusterNode,
    k8s: K8sNodeInfo | undefined,
  ): ClusterNodeTreeNode {
    const item = new ResourceNode<ClusterNodeRef>(
      {cluster: cluster.name, version: cluster.kubernetesVersion, node, k8s},
      node.name,
    );
    item.id = `cluster:${cluster.name}:node:${node.name}`;
    // Only a running node can be exec'd into or sampled
    item.contextValue = running(node.status)
      ? 'clusterNode.running'
      : 'clusterNode';
    const healthy = running(node.status) && (k8s ? k8s.ready : true);
    item.iconPath = new vscode.ThemeIcon(
      node.roles.includes('control-plane') ? 'server-process' : 'server',
      new vscode.ThemeColor(
        healthy
          ? 'testing.iconPassed'
          : running(node.status)
            ? 'problemsWarningIcon.foreground'
            : 'disabledForeground',
      ),
    );
    item.description = [
      running(node.status)
        ? k8s?.status
        : (node.status ?? vscode.l10n.t('unknown')),
      node.roles.join(', '),
      node.addresses[0],
      node.ports.join(', '),
      k8s?.kubeletVersion,
    ]
      .filter(Boolean)
      .join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**').appendText(node.name).appendMarkdown('**\n\n');
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Roles'), node.roles.join(', ')],
      [vscode.l10n.t('State'), node.status],
      [vscode.l10n.t('Kubernetes'), k8s?.status],
      [vscode.l10n.t('Kubelet'), k8s?.kubeletVersion],
      [vscode.l10n.t('Addresses'), node.addresses.join(', ')],
      [vscode.l10n.t('Ports'), node.ports.join(', ')],
    ];
    for (const [k, v] of rows) {
      if (v) {
        md.appendMarkdown(`- ${k}: `).appendText(v).appendMarkdown('\n');
      }
    }
    item.tooltip = md;
    return item;
  }
}
