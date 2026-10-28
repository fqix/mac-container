import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';
import { ComposeProject, groupByComposeProject } from '../services/compose';
import { relativeTime } from '../utils/i18n';
import { formatBytes, formatPort, shortImageName } from '../utils/parse';
import type { ServiceMonitor } from '../services/state';
import type { ContainerMount, ContainerSummary, PortMapping } from '../models/types';
import { ResourceNode, ResourceProvider, TreeNode } from './base';

export type ContainerNode = ResourceNode<ContainerSummary>;

/** A container-compose project grouping its containers */
export class ComposeProjectNode extends vscode.TreeItem {
  constructor(readonly project: ComposeProject) {
    super(project.name, vscode.TreeItemCollapsibleState.Expanded);
    const running = project.containers.filter((c) => c.state === 'running').length;
    this.id = `compose:${project.name}`;
    this.contextValue = 'composeProject';
    this.iconPath = new vscode.ThemeIcon('layers', running ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    this.description = vscode.l10n.t('{0}/{1} running', running, project.containers.length);
    this.tooltip = vscode.l10n.t('container-compose project {0}', project.name);
  }
}

/** The "Volumes" / "Ports" folder under a container */
export class ContainerSectionNode extends vscode.TreeItem {
  constructor(
    readonly container: ContainerSummary,
    readonly section: 'volumes' | 'ports',
  ) {
    super(section === 'volumes' ? vscode.l10n.t('Volumes') : vscode.l10n.t('Ports'), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `container:${container.id}/${section}`;
    this.contextValue = `container.${section}`;
    this.iconPath = new vscode.ThemeIcon(section === 'volumes' ? 'database' : 'plug');
    this.description = String(section === 'volumes' ? container.mounts.length : container.publishedPorts.length);
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
    this.iconPath = new vscode.ThemeIcon(mount.kind === 'bind' ? 'folder' : mount.kind === 'volume' ? 'database' : 'file-symlink-directory');
    this.description = [mount.source || mount.kind, mount.readOnly ? 'ro' : undefined].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`- ${vscode.l10n.t('Type')}: ${mountKindLabel(mount.kind)}\n`);
    if (mount.source) {
      md.appendMarkdown(`- ${vscode.l10n.t('Source')}: `).appendText(mount.source).appendMarkdown('\n');
    }
    md.appendMarkdown(`- ${vscode.l10n.t('Destination')}: `).appendText(mount.destination).appendMarkdown('\n');
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
    this.contextValue = container.state === 'running' && port.proto === 'tcp' ? 'port.tcp' : 'port';
    this.iconPath = new vscode.ThemeIcon('plug');
  }

  /** URL reachable from this Mac; 0.0.0.0 means every interface, so use localhost */
  get url(): string {
    const host = !this.port.hostAddress || this.port.hostAddress === '0.0.0.0' ? 'localhost' : this.port.hostAddress;
    return `http://${host.includes(':') ? `[${host}]` : host}:${this.port.hostPort}`;
  }
}

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
    return items.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.id.localeCompare(b.id));
  }

  protected override rootNodes(items: ContainerSummary[]): TreeNode[] {
    const { projects, standalone } = groupByComposeProject(items);
    return [...projects.map((p) => new ComposeProjectNode(p)), ...standalone.map((c) => this.toNode(c))];
  }

  protected override childNodes(element: TreeNode): TreeNode[] {
    if (element instanceof ComposeProjectNode) {
      return element.project.containers.map((c) => this.toNode(c));
    }
    if (element instanceof ResourceNode) {
      const c = element.resource as ContainerSummary;
      // Sections only appear when they have entries
      const sections: TreeNode[] = [];
      if (c.mounts.length) {
        sections.push(new ContainerSectionNode(c, 'volumes'));
      }
      if (c.publishedPorts.length) {
        sections.push(new ContainerSectionNode(c, 'ports'));
      }
      return sections;
    }
    if (element instanceof ContainerSectionNode) {
      return element.section === 'volumes'
        ? element.container.mounts.map((m) => new MountNode(element.container, m))
        : element.container.publishedPorts.map((p) => new PortNode(element.container, p));
    }
    return [];
  }

  protected toNode(c: ContainerSummary): ContainerNode {
    const running = c.state === 'running';
    const node = new ResourceNode(c, c.id);
    node.id = `container:${c.id}`;
    node.collapsibleState =
      c.mounts.length || c.publishedPorts.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    // Compose-managed containers get a suffix: they are edited through their compose file, not recreated here
    node.contextValue = `container.${running ? 'running' : 'stopped'}${c.composeProject ? '.compose' : ''}`;
    node.iconPath = running
      ? new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('vm-outline');
    const parts = [c.composeService ?? shortImageName(c.image)];
    if (running && c.ipv4) {
      parts.push(c.ipv4);
    }
    parts.push(running ? vscode.l10n.t('Started {0}', relativeTime(c.startedAt)) : stateLabel(c.state));
    node.description = parts.join(' · ');

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${c.id}** — ${stateLabel(c.state)}\n\n`);
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Image'), c.image],
      [vscode.l10n.t('Command'), c.command],
      [vscode.l10n.t('Compose Project'), c.composeProject && `${c.composeProject} / ${c.composeService ?? ''}`],
      [vscode.l10n.t('IP Address'), c.ipv4],
      [vscode.l10n.t('Networks'), c.networks.join(', ')],
      [vscode.l10n.t('Ports'), c.ports.join(', ')],
      [vscode.l10n.t('Resources'), c.cpus ? vscode.l10n.t('{0} CPUs, {1} memory', c.cpus, formatBytes(c.memoryBytes)) : undefined],
      [vscode.l10n.t('Platform'), c.platform],
      [vscode.l10n.t('Created'), c.createdAt ? `${new Date(c.createdAt).toLocaleString(vscode.env.language)} (${relativeTime(c.createdAt)})` : undefined],
    ];
    for (const [k, v] of rows) {
      if (v) {
        md.appendMarkdown(`- ${k}: `).appendText(v).appendMarkdown('\n');
      }
    }
    node.tooltip = md;
    return node;
  }
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
