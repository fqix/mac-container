import * as vscode from 'vscode';

import type { ContainerCli } from '../cli';
import { relativeTime } from '../i18n';
import type { ServiceMonitor } from '../state';
import type { RegistrySummary } from '../types';
import { ResourceNode, ResourceProvider } from './base';

export type RegistryNode = ResourceNode<RegistrySummary>;

export class RegistriesProvider extends ResourceProvider<RegistrySummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<RegistrySummary[]> {
    return (await this.cli.listRegistries()).sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  protected toNode(registry: RegistrySummary): RegistryNode {
    const node = new ResourceNode(registry, registry.hostname);
    node.id = `registry:${registry.hostname}`;
    node.contextValue = 'registry';
    node.iconPath = new vscode.ThemeIcon('account');
    node.description = registry.username;
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**').appendText(registry.hostname).appendMarkdown('**\n\n');
    md.appendMarkdown(`- ${vscode.l10n.t('Username')}: `).appendText(registry.username).appendMarkdown('\n');
    if (registry.modifiedAt) {
      md.appendMarkdown(`- ${vscode.l10n.t('Logged in')}: ${relativeTime(registry.modifiedAt)}\n`);
    }
    node.tooltip = md;
    return node;
  }
}
