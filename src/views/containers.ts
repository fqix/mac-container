import * as vscode from 'vscode';

import type {ContainerCli} from '../services/cli';
import {ComposeProject, groupByComposeProject} from '../services/compose';
import {relativeTime} from '../utils/i18n';
import {formatBytes, formatPort, shortImageName} from '../utils/parse';
import {
  containerPortUrl,
  type ListeningPort,
  LISTENING_PORTS_SCRIPT,
  parseListeningPorts,
} from '../utils/ports';
import type {ServiceMonitor} from '../services/state';
import type {
  ContainerMount,
  ContainerSummary,
  PortMapping,
} from '../models/types';
import {ResourceNode, ResourceProvider, TreeNode} from './base';

export type ContainerNode = ResourceNode<ContainerSummary>;

/** A container-compose project grouping its containers */
export class ComposeProjectNode extends vscode.TreeItem {
  constructor(readonly project: ComposeProject) {
    super(project.name, vscode.TreeItemCollapsibleState.Expanded);
    const running = project.containers.filter(
      c => c.state === 'running',
    ).length;
    this.id = `compose:${project.name}`;
    this.contextValue = 'composeProject';
    this.iconPath = new vscode.ThemeIcon(
      'layers',
      running ? new vscode.ThemeColor('testing.iconPassed') : undefined,
    );
    this.description = vscode.l10n.t(
      '{0}/{1} running',
      running,
      project.containers.length,
    );
    this.tooltip = vscode.l10n.t('container-compose project {0}', project.name);
  }
}

/** The "Volumes" / "Ports" folder under a container */
export class ContainerSectionNode extends vscode.TreeItem {
  constructor(
    readonly container: ContainerSummary,
    readonly section: 'volumes' | 'ports',
  ) {
    super(
      section === 'volumes' ? vscode.l10n.t('Volumes') : vscode.l10n.t('Ports'),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `container:${container.id}/${section}`;
    this.contextValue = `container.${section}`;
    this.iconPath = new vscode.ThemeIcon(
      section === 'volumes' ? 'database' : 'plug',
    );
    // Listening ports are only known once the section is expanded, so a running container's Ports show no count
    const count =
      section === 'volumes'
        ? container.mounts.length
        : container.publishedPorts.length;
    this.description = count ? String(count) : undefined;
  }
}

export class MountNode extends vscode.TreeItem {
  constructor(
    readonly container: ContainerSummary,
    readonly mount: ContainerMount,
  ) {
    super(mount.destination, vscode.TreeItemCollapsibleState.None);
    this.id = `container:${container.id}/volumes/${mount.destination}`;
    this.contextValue = `mount.${mount.kind}`;
    this.iconPath = new vscode.ThemeIcon(
      mount.kind === 'bind'
        ? 'folder'
        : mount.kind === 'volume'
          ? 'database'
          : 'file-symlink-directory',
    );
    this.description = [
      mount.source || mount.kind,
      mount.readOnly ? 'ro' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `- ${vscode.l10n.t('Type')}: ${mountKindLabel(mount.kind)}\n`,
    );
    if (mount.source) {
      md.appendMarkdown(`- ${vscode.l10n.t('Source')}: `)
        .appendText(mount.source)
        .appendMarkdown('\n');
    }
    md.appendMarkdown(`- ${vscode.l10n.t('Destination')}: `)
      .appendText(mount.destination)
      .appendMarkdown('\n');
    if (mount.readOnly) {
      md.appendMarkdown(`- ${vscode.l10n.t('Read-only')}\n`);
    }
    this.tooltip = md;
  }
}

export class PortNode extends vscode.TreeItem {
  constructor(
    readonly container: ContainerSummary,
    readonly port: PortMapping,
  ) {
    super(formatPort(port), vscode.TreeItemCollapsibleState.None);
    this.id = `container:${container.id}/ports/${port.hostAddress}:${port.hostPort}/${port.proto}`;
    // Only TCP ports on a running container can be opened in a browser
    this.contextValue =
      container.state === 'running' && port.proto === 'tcp'
        ? 'port.tcp'
        : 'port';
    this.iconPath = new vscode.ThemeIcon('plug');
  }

  /** URL reachable from this Mac; 0.0.0.0 means every interface, so use localhost */
  get url(): string {
    const host =
      !this.port.hostAddress || this.port.hostAddress === '0.0.0.0'
        ? 'localhost'
        : this.port.hostAddress;
    return `http://${host.includes(':') ? `[${host}]` : host}:${this.port.hostPort}`;
  }
}

/** A port a process listens on in the container, reached through the container's IP without --publish */
export class ListeningPortNode extends vscode.TreeItem {
  constructor(
    readonly container: ContainerSummary,
    readonly port: ListeningPort,
  ) {
    super(`${port.port}/tcp`, vscode.TreeItemCollapsibleState.None);
    this.id = `container:${container.id}/listening/${port.port}`;
    const md = new vscode.MarkdownString();
    md.appendText(
      vscode.l10n.t('Listening on {0}', port.addresses.join(', ')),
    ).appendMarkdown('\n\n');
    if (port.reachable && container.ipv4) {
      this.contextValue = 'port.tcp';
      this.iconPath = new vscode.ThemeIcon('radio-tower');
      this.description = vscode.l10n.t('{0} (not published)', this.url);
      md.appendText(
        vscode.l10n.t(
          'Not published: reachable from this Mac through the container IP, not through localhost or from other devices.',
        ),
      );
    } else {
      this.contextValue = 'port.loopback';
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('problemsWarningIcon.foreground'),
      );
      this.description = vscode.l10n.t('loopback only');
      md.appendText(
        vscode.l10n.t(
          'Only listens on a loopback address, so it cannot be reached from this Mac. Listen on 0.0.0.0 instead, or forward the port over Remote-SSH.',
        ),
      );
    }
    this.tooltip = md;
  }

  get url(): string {
    return containerPortUrl(this.container.ipv4 ?? '', this.port.port);
  }
}

/** How long listening ports are reused before the container is asked again */
const LISTENING_PORTS_TTL_MS = 15_000;

export class ContainersProvider extends ResourceProvider<ContainerSummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<ContainerSummary[]> {
    const items = await this.cli.listContainers();
    // Running containers first, then by ID
    return items.sort(
      (a, b) =>
        Number(b.state === 'running') - Number(a.state === 'running') ||
        a.id.localeCompare(b.id),
    );
  }

  protected override rootNodes(items: ContainerSummary[]): TreeNode[] {
    const {projects, standalone} = groupByComposeProject(items);
    return [
      ...projects.map(p => new ComposeProjectNode(p)),
      ...standalone.map(c => this.toNode(c)),
    ];
  }

  protected override async childNodes(element: TreeNode): Promise<TreeNode[]> {
    if (element instanceof ComposeProjectNode) {
      return element.project.containers.map(c => this.toNode(c));
    }
    if (element instanceof ResourceNode) {
      const c = element.resource as ContainerSummary;
      // Sections only appear when they have entries; a running container may have listening ports
      const sections: TreeNode[] = [];
      if (c.mounts.length) {
        sections.push(new ContainerSectionNode(c, 'volumes'));
      }
      if (hasPortsSection(c)) {
        sections.push(new ContainerSectionNode(c, 'ports'));
      }
      return sections;
    }
    if (element instanceof ContainerSectionNode) {
      const c = element.container;
      if (element.section === 'volumes') {
        return c.mounts.map(m => new MountNode(c, m));
      }
      const published = new Set(
        c.publishedPorts
          .filter(p => p.proto === 'tcp')
          .map(p => p.containerPort),
      );
      const listening = (await this.listeningPorts(c)).filter(
        p => !published.has(p.port),
      );
      const ports = [
        ...c.publishedPorts.map(p => new PortNode(c, p)),
        ...listening.map(p => new ListeningPortNode(c, p)),
      ];
      if (!ports.length) {
        // The section is shown for every running container, before its listening ports are known
        const none = new vscode.TreeItem(
          vscode.l10n.t('No published or listening ports'),
        );
        none.id = `container:${c.id}/ports/none`;
        none.iconPath = new vscode.ThemeIcon('info');
        return [none];
      }
      return ports;
    }
    return [];
  }

  /** Listening ports read recently, per container run; polling refreshes expanded sections every few seconds */
  private readonly listeningCache = new Map<
    string,
    {at: number; ports: Promise<ListeningPort[]>}
  >();

  /** Read when the Ports section is expanded; images without a shell or cat just show no listening ports */
  private listeningPorts(c: ContainerSummary): Promise<ListeningPort[]> {
    if (c.state !== 'running') {
      return Promise.resolve([]);
    }
    const key = `${c.id}@${c.startedAt ?? ''}`;
    const cached = this.listeningCache.get(key);
    if (cached && Date.now() - cached.at < LISTENING_PORTS_TTL_MS) {
      return cached.ports;
    }
    const ports = this.cli
      .run(['exec', c.id, 'sh', '-c', LISTENING_PORTS_SCRIPT], {
        timeoutMs: 5_000,
      })
      .then(parseListeningPorts, () => []);
    // Entries of other runs and of removed containers go when the cache is written
    for (const [k, v] of this.listeningCache) {
      if (Date.now() - v.at >= LISTENING_PORTS_TTL_MS) {
        this.listeningCache.delete(k);
      }
    }
    this.listeningCache.set(key, {at: Date.now(), ports});
    return ports;
  }

  protected toNode(c: ContainerSummary): ContainerNode {
    const running = c.state === 'running';
    const node = new ResourceNode(c, c.id);
    node.id = `container:${c.id}`;
    node.collapsibleState =
      c.mounts.length || hasPortsSection(c)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    // Compose-managed containers get a suffix: they are edited through their compose file, not recreated here.
    // The BuildKit builder gets the builder commands (`container builder ...`) instead of the container ones.
    node.contextValue = c.builder
      ? `builder.${running ? 'running' : 'stopped'}`
      : `container.${running ? 'running' : 'stopped'}${c.composeProject ? '.compose' : ''}`;
    const passed = new vscode.ThemeColor('testing.iconPassed');
    node.iconPath = c.builder
      ? new vscode.ThemeIcon('tools', running ? passed : undefined)
      : running
        ? new vscode.ThemeIcon('vm-running', passed)
        : new vscode.ThemeIcon('vm-outline');
    const parts = [
      c.builder
        ? vscode.l10n.t('Builder')
        : (c.composeService ?? shortImageName(c.image)),
    ];
    if (running && c.ipv4) {
      parts.push(c.ipv4);
    }
    parts.push(
      running
        ? vscode.l10n.t('Started {0}', relativeTime(c.startedAt))
        : stateLabel(c.state),
    );
    node.description = parts.join(' · ');

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${c.id}** — ${stateLabel(c.state)}\n\n`);
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Image'), c.image],
      [vscode.l10n.t('Command'), c.command],
      [
        vscode.l10n.t('Compose Project'),
        c.composeProject && `${c.composeProject} / ${c.composeService ?? ''}`,
      ],
      [vscode.l10n.t('IP Address'), c.ipv4],
      [vscode.l10n.t('Networks'), c.networks.join(', ')],
      [vscode.l10n.t('Ports'), c.ports.join(', ')],
      [
        vscode.l10n.t('Resources'),
        c.cpus
          ? vscode.l10n.t(
              '{0} CPUs, {1} memory',
              c.cpus,
              formatBytes(c.memoryBytes),
            )
          : undefined,
      ],
      [vscode.l10n.t('Platform'), c.platform],
      [
        vscode.l10n.t('Created'),
        c.createdAt
          ? `${new Date(c.createdAt).toLocaleString(vscode.env.language)} (${relativeTime(c.createdAt)})`
          : undefined,
      ],
    ];
    for (const [k, v] of rows) {
      if (v) {
        md.appendMarkdown(`- ${k}: `).appendText(v).appendMarkdown('\n');
      }
    }
    if (c.builder) {
      md.appendMarkdown('\n').appendText(
        vscode.l10n.t(
          'Builds use the CPUs and memory of the build.cpus / build.memory system properties.',
        ),
      );
    }
    node.tooltip = md;
    return node;
  }
}

/** Published ports, or a running container that may listen on ports reachable through its IP */
function hasPortsSection(c: ContainerSummary): boolean {
  return c.publishedPorts.length > 0 || (c.state === 'running' && !c.builder);
}

export function stateLabel(state: string): string {
  switch (state) {
    case 'running':
      return vscode.l10n.t('Running');
    case 'stopped':
      return vscode.l10n.t('Stopped');
    case 'stopping':
      return vscode.l10n.t('Stopping');
    default:
      return state;
  }
}

function mountKindLabel(kind: string): string {
  switch (kind) {
    case 'volume':
      return vscode.l10n.t('Named volume');
    case 'bind':
      return vscode.l10n.t('Bind mount');
    default:
      return kind;
  }
}
