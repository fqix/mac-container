import * as vscode from 'vscode';

import {ContainerCli} from './services/cli';
import type {CommandContext} from './commands/common';
import {register} from './commands/common';
import {registerBuilderCommands} from './commands/builder';
import {registerComposeCommands} from './commands/compose';
import {registerContainerCommands} from './commands/containers';
import {
  installDevContainerExtensions,
  registerDevContainerCommands,
} from './commands/devcontainer';
import {registerFileCommands} from './commands/files';
import {registerRemoteSshCommands} from './commands/remoteSsh';
import {registerImageCommands} from './commands/images';
import {registerNetworkCommands} from './commands/networks';
import {registerPortAndMountCommands} from './commands/ports';
import {registerRegistryCommands} from './commands/registries';
import {registerSystemCommands} from './commands/system';
import {registerVolumeCommands} from './commands/volumes';
import {DOCUMENT_SCHEME, ReadonlyDocumentProvider} from './ui/documents';
import {BuildFormPanel} from './panels/buildFormPanel';
import {ContainerFormPanel} from './panels/containerFormPanel';
import {findConfigFiles} from './services/devcontainer';
import {ServiceMonitor} from './services/state';
import {StatsPanel} from './panels/statsPanel';
import {ServiceStatusBar} from './ui/statusBar';
import type {ResourceProvider} from './views/base';
import {ContainersProvider} from './views/containers';
import {ImagesProvider} from './views/images';
import {NetworksProvider} from './views/networks';
import {RegistriesProvider} from './views/registries';
import {VolumesProvider} from './views/volumes';

/** Returned from activate() so e2e tests can reach the providers and the CLI */
export interface ExtensionApi {
  cli: ContainerCli;
  monitor: ServiceMonitor;
  views: CommandContext['views'];
}

export function activate(
  context: vscode.ExtensionContext,
): ExtensionApi | undefined {
  // A remote window (e.g. a dev container over Remote-SSH) runs this UI extension too. package.json hides its views
  // and commands there (!remoteName); the only work left is installing the extensions of a dev container.
  if (vscode.env.remoteName) {
    void installDevContainerExtensions(context);
    return undefined;
  }

  // Apple container only runs on Apple silicon Macs
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Apple Container requires a Mac with Apple silicon.'),
    );
    return undefined;
  }

  const config = () => vscode.workspace.getConfiguration('appleContainer');
  const cli = new ContainerCli(() => config().get<string>('path', 'container'));
  const monitor = new ServiceMonitor(cli);
  const documents = new ReadonlyDocumentProvider();

  const views = {
    containers: new ContainersProvider(monitor, cli),
    images: new ImagesProvider(monitor, cli),
    networks: new NetworksProvider(monitor, cli),
    volumes: new VolumesProvider(monitor, cli),
    registries: new RegistriesProvider(monitor, cli),
  };
  const treeViews: [vscode.TreeView<unknown>, ResourceProvider<unknown>][] =
    Object.entries(views).map(([key, provider]) => {
      const p = provider as ResourceProvider<unknown>;
      // Containers nest compose groups, containers and their Volumes / Ports sections
      const showCollapseAll = key === 'containers';
      return [
        vscode.window.createTreeView(`appleContainer.${key}`, {
          treeDataProvider: p,
          canSelectMany: true,
          showCollapseAll,
        }),
        p,
      ];
    });

  const refreshAll = async () => {
    await monitor.check();
    for (const [, provider] of treeViews) {
      provider.refresh();
    }
  };

  context.subscriptions.push(
    {dispose: () => StatsPanel.disposeAll()},
    {dispose: () => ContainerFormPanel.disposeAll()},
    {dispose: () => BuildFormPanel.disposeAll()},
    monitor,
    documents,
    vscode.workspace.registerTextDocumentContentProvider(
      DOCUMENT_SCHEME,
      documents,
    ),
    ...treeViews.flatMap(([view, provider]) => [view, provider]),
    // Service started or stopped: every view switches between its content and the welcome message
    monitor.onDidChangeKind(() => treeViews.forEach(([, p]) => p.refresh())),
  );

  // onStartupFinished activates every local window, so the status bar item and polling wait until the window uses
  // the extension: a view is shown, a command runs, or the workspace has a devcontainer.json
  let started = false;
  const start = () => {
    if (started) {
      return;
    }
    started = true;
    context.subscriptions.push(new ServiceStatusBar(monitor));
    startPolling();
    void monitor.check();
  };

  const ctx: CommandContext = {
    extension: context,
    cli,
    monitor,
    documents,
    views,
    refreshAll,
    start,
  };
  register(ctx, 'appleContainer.refresh', refreshAll);
  registerContainerCommands(ctx);
  registerRemoteSshCommands(ctx);
  registerFileCommands(ctx);
  registerDevContainerCommands(ctx);
  registerComposeCommands(ctx);
  registerPortAndMountCommands(ctx);
  registerImageCommands(ctx);
  registerBuilderCommands(ctx);
  registerNetworkCommands(ctx);
  registerVolumeCommands(ctx);
  registerRegistryCommands(ctx);
  registerSystemCommands(ctx);

  // Poll only the visible views so a hidden sidebar costs nothing beyond the status check
  let timer: NodeJS.Timeout | undefined;
  const startPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    const seconds = config().get<number>('refreshInterval', 5);
    if (seconds <= 0) {
      return;
    }
    timer = setInterval(async () => {
      const before = monitor.state.kind;
      const state = await monitor.check();
      if (state.kind !== 'running' || before !== 'running') {
        return;
      }
      for (const [view, provider] of treeViews) {
        if (view.visible) {
          provider.refresh();
        }
      }
    }, seconds * 1000);
  };
  context.subscriptions.push(
    {dispose: () => timer && clearInterval(timer)},
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!started) {
        return;
      }
      if (e.affectsConfiguration('appleContainer.path')) {
        cli.reset();
        void refreshAll();
      }
      if (e.affectsConfiguration('appleContainer.refreshInterval')) {
        startPolling();
      }
    }),
    ...treeViews.map(([view]) =>
      view.onDidChangeVisibility(e => e.visible && start()),
    ),
  );

  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    f => f.uri.scheme === 'file',
  );
  if (
    treeViews.some(([view]) => view.visible) ||
    folders.some(f => findConfigFiles(f.uri.fsPath).length)
  ) {
    start();
  }
  return {cli, monitor, views};
}

export function deactivate(): void {}
