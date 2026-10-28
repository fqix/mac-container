// Status bar item showing whether the container system service is running

import * as vscode from 'vscode';

import type { ServiceMonitor, ServiceState } from './state';

export class ServiceStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('appleContainer.status', vscode.StatusBarAlignment.Left, 50);
  private readonly subscription: vscode.Disposable;

  constructor(monitor: ServiceMonitor) {
    this.item.name = 'Apple Container';
    this.item.command = 'appleContainer.system.menu';
    this.subscription = monitor.onDidUpdate((state) => this.render(state));
    this.render(monitor.state);
    this.item.show();
  }

  private render(state: ServiceState): void {
    this.item.backgroundColor = undefined;
    switch (state.kind) {
      case 'running': {
        const { containersRunning = 0, containersTotal = 0, serverVersion } = state.status;
        this.item.text = `$(vm-running) ${containersRunning}/${containersTotal}`;
        this.item.tooltip = vscode.l10n.t(
          'container service running (v{0})\n{1} of {2} containers running',
          serverVersion ?? '?',
          containersRunning,
          containersTotal,
        );
        break;
      }
      case 'stopped':
        this.item.text = '$(vm-outline) container';
        this.item.tooltip = vscode.l10n.t('container service is stopped. Click to start it.');
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'cliMissing':
        this.item.text = '$(warning) container';
        this.item.tooltip = vscode.l10n.t('container CLI not found');
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'error':
        this.item.text = '$(error) container';
        this.item.tooltip = state.message;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      default:
        this.item.text = '$(loading~spin) container';
        this.item.tooltip = undefined;
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
