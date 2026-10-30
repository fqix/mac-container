import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';
import type { ServiceMonitor } from '../services/state';
import type { ContainerSummary } from '../models/types';
import { relativeTime } from '../utils/i18n';
import { formatBytes, shortImageName } from '../utils/parse';
import { ResourceNode, ResourceProvider } from './base';
import { stateLabel } from './containers';

/** The builder is a container, so container commands such as logs and inspect accept its node */
export type BuilderNode = ResourceNode<ContainerSummary>;

/** The BuildKit container that runs image builds; empty until the first build or Start Builder */
export class BuilderProvider extends ResourceProvider<ContainerSummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<ContainerSummary[]> {
    return (await this.cli.listContainers()).filter((c) => c.builder);
  }

  protected toNode(c: ContainerSummary): BuilderNode {
    const running = c.state === 'running';
    const node = new ResourceNode(c, c.id);
    node.id = `builder:${c.id}`;
    node.contextValue = `builder.${running ? 'running' : 'stopped'}`;
    node.iconPath = new vscode.ThemeIcon('tools', running ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    const resources = c.cpus ? vscode.l10n.t('{0} CPUs, {1} memory', c.cpus, formatBytes(c.memoryBytes)) : undefined;
    node.description = [shortImageName(c.image), running ? vscode.l10n.t('Started {0}', relativeTime(c.startedAt)) : stateLabel(c.state), resources]
      .filter(Boolean)
      .join(' · ');

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${c.id}** — ${stateLabel(c.state)}\n\n`);
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Image'), c.image],
      [vscode.l10n.t('IP Address'), c.ipv4],
      [vscode.l10n.t('Resources'), resources],
      [vscode.l10n.t('Created'), c.createdAt ? `${new Date(c.createdAt).toLocaleString(vscode.env.language)} (${relativeTime(c.createdAt)})` : undefined],
    ];
    for (const [k, v] of rows) {
      if (v) {
        md.appendMarkdown(`- ${k}: `).appendText(v).appendMarkdown('\n');
      }
    }
    md.appendMarkdown('\n').appendText(vscode.l10n.t('Builds use the CPUs and memory of the build.cpus / build.memory system properties.'));
    node.tooltip = md;
    return node;
  }
}
