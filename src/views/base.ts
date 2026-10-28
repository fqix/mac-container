// Base TreeDataProvider shared by the four resource views

import * as vscode from 'vscode';

import { describeError } from '../i18n';
import type { ServiceMonitor } from '../state';

export class ResourceNode<T> extends vscode.TreeItem {
  constructor(
    readonly resource: T,
    label: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    this.tooltip = message;
  }
}

export type TreeNode = vscode.TreeItem;

export abstract class ResourceProvider<T> implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(protected readonly monitor: ServiceMonitor) {}

  protected abstract fetch(): Promise<T[]>;
  protected abstract toNode(resource: T): ResourceNode<T>;

  /** Top-level nodes; views that group resources override this */
  protected rootNodes(items: T[]): TreeNode[] {
    return items.map((r) => this.toNode(r));
  }

  /** Children of an expandable node; flat views have none */
  protected childNodes(_element: TreeNode): TreeNode[] {
    return [];
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      return this.childNodes(element);
    }
    const state = this.monitor.state.kind === 'unknown' ? await this.monitor.check() : this.monitor.state;
    // An empty result shows viewsWelcome (CLI missing / service stopped)
    if (state.kind === 'cliMissing' || state.kind === 'stopped') {
      return [];
    }
    if (state.kind === 'error') {
      return [new MessageNode(state.message)];
    }
    try {
      return this.rootNodes(await this.fetch());
    } catch (error) {
      return [new MessageNode(describeError(error))];
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
