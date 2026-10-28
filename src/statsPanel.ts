// Webview panel with live CPU / memory / network / block I/O charts for one container

import * as vscode from 'vscode';

import type { ContainerCli } from './cli';
import { describeError } from './i18n';
import { StatsMessage, toSample } from './stats';
import type { ContainerStats } from './types';
import { webviewHtml, webviewRoot } from './webviewHtml';

export class StatsPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, StatsPanel>();

  static show(extensionUri: vscode.Uri, cli: ContainerCli, containerId: string): void {
    const existing = StatsPanel.panels.get(containerId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    StatsPanel.panels.set(containerId, new StatsPanel(extensionUri, cli, containerId));
  }

  static disposeAll(): void {
    for (const panel of [...StatsPanel.panels.values()]) {
      panel.dispose();
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private timer: NodeJS.Timeout | undefined;
  private previous: { stats: ContainerStats; time: number } | undefined;
  private polling = false;
  private disposed = false;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly cli: ContainerCli,
    private readonly containerId: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'appleContainer.stats',
      vscode.l10n.t('Stats: {0}', containerId),
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [webviewRoot(extensionUri)], retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'container.svg');
    this.panel.webview.html = this.html(extensionUri);
    this.panel.onDidDispose(() => this.dispose());
    // Stop sampling while the panel is hidden; the chart keeps its history
    this.panel.onDidChangeViewState(() => this.schedule());
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.disposed || !this.panel.visible || this.polling) {
      return;
    }
    void this.loop();
  }

  /**
   * `container stats --no-stream` itself takes about 2 s, so the next sample is scheduled when the
   * previous one finishes; a fixed interval would skip every other tick while a call is running.
   */
  private async loop(): Promise<void> {
    const started = Date.now();
    await this.poll();
    if (this.disposed || !this.panel.visible) {
      return;
    }
    const seconds = Math.max(1, vscode.workspace.getConfiguration('appleContainer').get<number>('statsInterval', 2));
    this.timer = setTimeout(() => void this.loop(), Math.max(0, seconds * 1000 - (Date.now() - started)));
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const [stats] = await this.cli.stats([this.containerId]);
      const now = Date.now();
      if (!stats) {
        this.post({ type: 'status', text: vscode.l10n.t('Container is not running.'), error: true });
        this.previous = undefined;
        return;
      }
      // The first reading is sent right away so the panel fills immediately; its rates are null
      const sample = toSample(stats, this.previous?.stats, now - (this.previous?.time ?? now), now);
      this.post({ type: 'sample', sample });
      this.previous = { stats, time: now };
      this.post({ type: 'status', text: '' });
    } catch (error) {
      this.previous = undefined;
      this.post({ type: 'status', text: describeError(error), error: true });
    } finally {
      this.polling = false;
    }
  }

  private post(message: StatsMessage): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private html(extensionUri: vscode.Uri): string {
    const labels = {
      cpu: vscode.l10n.t('CPU'),
      memory: vscode.l10n.t('Memory'),
      network: vscode.l10n.t('Network I/O'),
      block: vscode.l10n.t('Block I/O'),
      received: vscode.l10n.t('Received'),
      sent: vscode.l10n.t('Sent'),
      read: vscode.l10n.t('Read'),
      write: vscode.l10n.t('Write'),
      limit: vscode.l10n.t('Limit'),
      processes: vscode.l10n.t('Processes'),
      waiting: vscode.l10n.t('Collecting samples...'),
      cpuHint: vscode.l10n.t('100% = one CPU core'),
    };
    return webviewHtml(this.panel.webview, extensionUri, 'stats', this.containerId, { container: this.containerId, labels: JSON.stringify(labels) });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    StatsPanel.panels.delete(this.containerId);
    this.panel.dispose();
  }
}
