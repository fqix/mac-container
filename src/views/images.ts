import * as vscode from 'vscode';

import type {ContainerCli} from '../services/cli';
import {relativeTime} from '../utils/i18n';
import {
  formatBytes,
  groupImagesByRepository,
  splitImageName,
} from '../utils/parse';
import type {ImageRepository} from '../utils/parse';
import type {ServiceMonitor} from '../services/state';
import type {ImageSummary} from '../models/types';
import {ResourceNode, ResourceProvider} from './base';
import type {TreeNode} from './base';

export type ImageNode = ResourceNode<ImageSummary>;

/** A repository grouping its tags, e.g. `ubuntu` with `22.04` and `latest` */
export class ImageRepositoryNode extends vscode.TreeItem {
  constructor(readonly repository: ImageRepository) {
    super(repository.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `imageRepository:${repository.name}`;
    this.contextValue = 'imageRepository';
    this.iconPath = new vscode.ThemeIcon('package');
    const count = repository.images.length;
    this.description =
      count === 1 ? vscode.l10n.t('1 tag') : vscode.l10n.t('{0} tags', count);
    this.tooltip = repository.name;
  }
}

export class ImagesProvider extends ResourceProvider<ImageSummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<ImageSummary[]> {
    // Sorted by groupImagesByRepository
    return this.cli.listImages();
  }

  protected rootNodes(images: ImageSummary[]): TreeNode[] {
    return groupImagesByRepository(images).map(r => new ImageRepositoryNode(r));
  }

  protected childNodes(element: TreeNode): TreeNode[] {
    return element instanceof ImageRepositoryNode
      ? element.repository.images.map(i => this.toNode(i))
      : [];
  }

  protected toNode(image: ImageSummary): ImageNode {
    const node = new ResourceNode(image, splitImageName(image.displayName).tag);
    node.id = `image:${image.reference}`;
    node.contextValue = 'image';
    node.iconPath = new vscode.ThemeIcon('tag');
    node.description = [
      formatBytes(image.sizeBytes),
      relativeTime(image.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**')
      .appendText(image.reference)
      .appendMarkdown('**\n\n');
    md.appendMarkdown(`- ${vscode.l10n.t('Digest')}: `)
      .appendText(image.digest)
      .appendMarkdown('\n');
    md.appendMarkdown(
      `- ${vscode.l10n.t('Size')}: ${formatBytes(image.sizeBytes)}\n`,
    );
    if (image.platforms.length) {
      md.appendMarkdown(`- ${vscode.l10n.t('Platform')}: `)
        .appendText(image.platforms.join(', '))
        .appendMarkdown('\n');
    }
    node.tooltip = md;
    return node;
  }
}
