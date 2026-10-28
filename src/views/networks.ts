import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';
import type { ServiceMonitor } from '../services/state';
import type { NetworkSummary } from '../models/types';
import { ResourceNode, ResourceProvider } from './base';

export type NetworkNode = ResourceNode<NetworkSummary>;

export class NetworksProvider extends ResourceProvider<NetworkSummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<NetworkSummary[]> {
    return (await this.cli.listNetworks()).sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.id.localeCompare(b.id));
  }

  protected toNode(network: NetworkSummary): NetworkNode {
    const node = new ResourceNode(network, network.id);
    node.id = `network:${network.id}`;
    // The built-in network (default) cannot be deleted
    node.contextValue = network.builtin ? 'network.builtin' : 'network';
    node.iconPath = new vscode.ThemeIcon(network.builtin ? 'globe' : 'type-hierarchy');
    node.description = [network.ipv4Subnet, network.mode, network.builtin ? vscode.l10n.t('built-in') : undefined]
      .filter(Boolean)
      .join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**').appendText(network.id).appendMarkdown('**\n\n');
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Mode'), network.mode],
      [vscode.l10n.t('IPv4 Subnet'), network.ipv4Subnet],
      [vscode.l10n.t('IPv4 Gateway'), network.ipv4Gateway],
      [vscode.l10n.t('IPv6 Subnet'), network.ipv6Subnet],
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
