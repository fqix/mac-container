import * as vscode from 'vscode';

import type { ContainerCli } from '../cli';
import { relativeTime } from '../i18n';
import { formatBytes } from '../parse';
import type { ServiceMonitor } from '../state';
import type { ImageSummary } from '../types';
import { ResourceNode, ResourceProvider } from './base';

export type ImageNode = ResourceNode<ImageSummary>;

export class ImagesProvider extends ResourceProvider<ImageSummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<ImageSummary[]> {
    return (await this.cli.listImages()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  protected toNode(image: ImageSummary): ImageNode {
    const node = new ResourceNode(image, image.displayName);
    node.id = `image:${image.reference}`;
    node.contextValue = 'image';
    node.iconPath = new vscode.ThemeIcon('package');
    node.description = [formatBytes(image.sizeBytes), relativeTime(image.createdAt)].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**').appendText(image.reference).appendMarkdown('**\n\n');
    md.appendMarkdown(`- ${vscode.l10n.t('Digest')}: `).appendText(image.digest).appendMarkdown('\n');
    md.appendMarkdown(`- ${vscode.l10n.t('Size')}: ${formatBytes(image.sizeBytes)}\n`);
    if (image.platforms.length) {
      md.appendMarkdown(`- ${vscode.l10n.t('Platform')}: `).appendText(image.platforms.join(', ')).appendMarkdown('\n');
    }
    node.tooltip = md;
    return node;
  }
}
