// Webview panel with the service status (`system status`) and disk usage (`system df`)

import * as vscode from 'vscode';

import type {ContainerCli} from '../services/cli';
import type {ServiceMonitor} from '../services/state';
import type {
  DiskUsageKind,
  SystemFromWebview,
  SystemToWebview,
} from '../services/systemOverview';
import type {ReadonlyDocumentProvider} from '../ui/documents';
import {describeError} from '../utils/i18n';
import {webviewHtml, webviewRoot} from './webviewHtml';

const PRUNE_COMMANDS: Record<DiskUsageKind, string> = {
  images: 'appleContainer.image.prune',
  containers: 'appleContainer.container.prune',
  volumes: 'appleContainer.volume.prune',
};

export interface SystemPanelDeps {
  extensionUri: vscode.Uri;
  cli: ContainerCli;
  monitor: ServiceMonitor;
  documents: ReadonlyDocumentProvider;
}

export class SystemPanel implements vscode.Disposable {
  private static current: SystemPanel | undefined;

  static show(deps: SystemPanelDeps): void {
    if (SystemPanel.current) {
      SystemPanel.current.panel.reveal();
      void SystemPanel.current.refresh();
      return;
    }
    SystemPanel.current = new SystemPanel(deps);
  }

  static disposeAll(): void {
    SystemPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Only the latest refresh posts its result */
  private generation = 0;
  private disposed = false;

  private constructor(private readonly deps: SystemPanelDeps) {
    this.panel = vscode.window.createWebviewPanel(
      'appleContainer.system',
      vscode.l10n.t('System Overview'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [webviewRoot(deps.extensionUri)],
        retainContextWhenHidden: true,
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      deps.extensionUri,
      'resources',
      'container.svg',
    );
    this.panel.webview.html = this.html();
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(
        (message: SystemFromWebview) => void this.handle(message),
      ),
      // Disk usage is not polled; it is reloaded when the panel is shown again or the service starts / stops
      this.panel.onDidChangeViewState(event => {
        if (event.webviewPanel.visible) {
          void this.refresh();
        }
      }),
      deps.monitor.onDidChangeKind(() => {
        if (this.panel.visible) {
          void this.refresh();
        }
      }),
    );
  }

  private async handle(message: SystemFromWebview): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.refresh();
          break;
        case 'start':
          await vscode.commands.executeCommand('appleContainer.system.start');
          await this.refresh();
          break;
        case 'prune':
          await vscode.commands.executeCommand(PRUNE_COMMANDS[message.kind]);
          await this.refresh();
          break;
        case 'reveal':
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(message.path),
          );
          break;
        case 'showJson':
          await this.deps.documents.open('/system/overview.json', async () =>
            JSON.stringify(
              {
                status: await this.deps.cli.json(['system', 'status']),
                df: await this.deps.cli.json(['system', 'df']),
              },
              null,
              2,
            ),
          );
          break;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(describeError(error));
    }
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.post({type: 'loading'});
    const {cli} = this.deps;
    let message: SystemToWebview;
    try {
      const status = await cli.systemStatus();
      message = {type: 'update', status, updatedAt: Date.now()};
      if (status.running) {
        try {
          message.usage = await cli.systemDf();
        } catch (error) {
          message.error = describeError(error);
        }
      }
    } catch (error) {
      message = {
        type: 'update',
        status: {running: false},
        error: describeError(error),
        updatedAt: Date.now(),
      };
    }
    if (generation === this.generation) {
      this.post(message);
    }
  }

  private post(message: SystemToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private html(): string {
    const labels = {
      title: vscode.l10n.t('System Overview'),
      refresh: vscode.l10n.t('Refresh'),
      showJson: vscode.l10n.t('Show JSON'),
      loading: vscode.l10n.t('Loading...'),
      updated: vscode.l10n.t('Updated {0}'),
      running: vscode.l10n.t('Running'),
      stopped: vscode.l10n.t('Stopped'),
      stoppedHint: vscode.l10n.t(
        'The container system service is not running.',
      ),
      start: vscode.l10n.t('Start System Service'),
      service: vscode.l10n.t('Service'),
      version: vscode.l10n.t('Version'),
      client: vscode.l10n.t('Client'),
      server: vscode.l10n.t('Server'),
      cpus: vscode.l10n.t('CPUs'),
      os: vscode.l10n.t('macOS'),
      paths: vscode.l10n.t('Paths'),
      appRoot: vscode.l10n.t('Data'),
      installRoot: vscode.l10n.t('Installation'),
      reveal: vscode.l10n.t('Reveal in Finder'),
      diskUsage: vscode.l10n.t('Disk Usage'),
      images: vscode.l10n.t('Images'),
      containers: vscode.l10n.t('Containers'),
      volumes: vscode.l10n.t('Volumes'),
      reclaimable: vscode.l10n.t('Reclaimable'),
      activeOfTotal: vscode.l10n.t('{0} in use of {1}'),
      prune: vscode.l10n.t('Prune'),
      total: vscode.l10n.t('Total'),
    };
    return webviewHtml(
      this.panel.webview,
      this.deps.extensionUri,
      'system',
      labels.title,
      {labels: JSON.stringify(labels)},
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    SystemPanel.current = undefined;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.panel.dispose();
  }
}
