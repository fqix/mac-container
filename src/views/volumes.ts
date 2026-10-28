import * as vscode from 'vscode';

import type { ContainerCli } from '../cli';
import { relativeTime } from '../i18n';
import { formatBytes } from '../parse';
import type { ServiceMonitor } from '../state';
import type { VolumeSummary } from '../types';
import { ResourceNode, ResourceProvider } from './base';

export type VolumeNode = ResourceNode<VolumeSummary>;

export class VolumesProvider extends ResourceProvider<VolumeSummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<VolumeSummary[]> {
    return (await this.cli.listVolumes()).sort((a, b) => a.name.localeCompare(b.name));
  }

  protected toNode(volume: VolumeSummary): VolumeNode {
    const node = new ResourceNode(volume, volume.name);
    node.id = `volume:${volume.name}`;
    node.contextValue = 'volume';
    node.iconPath = new vscode.ThemeIcon('database');
    // sizeInBytes is the volume capacity, not the space used
    node.description = [volume.format, relativeTime(volume.createdAt)].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**').appendText(volume.name).appendMarkdown('**\n\n');
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Driver'), volume.driver],
      [vscode.l10n.t('Format'), volume.format],
      [vscode.l10n.t('Capacity'), formatBytes(volume.sizeBytes)],
      [vscode.l10n.t('Source'), volume.source],
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
