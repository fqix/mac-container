import * as vscode from 'vscode';

import {SystemPanel} from '../panels/systemPanel';
import {openCliTerminal, runCliTask} from '../ui/terminal';
import {CommandContext, confirm, register, withProgress} from './common';

export function registerSystemCommands(ctx: CommandContext): void {
  const {cli} = ctx;

  register(ctx, 'appleContainer.system.start', async () => {
    // The first start may prompt to install the default kernel, so run it in a task terminal the user can type into
    await runCliTask(cli, vscode.l10n.t('Start container system service'), [
      'system',
      'start',
    ]);
    await ctx.refreshAll();
  });

  register(ctx, 'appleContainer.system.stop', async () => {
    if (
      !(await confirm(
        vscode.l10n.t('Stop the container system service?'),
        vscode.l10n.t('Stop'),
        vscode.l10n.t('All running containers will be stopped.'),
      ))
    ) {
      return;
    }
    await withProgress(
      vscode.l10n.t('Stopping container system service...'),
      () => cli.run(['system', 'stop'], {timeoutMs: 120_000}),
    );
    await ctx.refreshAll();
  });

  // Both open the overview panel: it shows the service status and the disk usage together
  const showOverview = () =>
    SystemPanel.show({
      extensionUri: ctx.extension.extensionUri,
      cli,
      monitor: ctx.monitor,
      documents: ctx.documents,
    });
  register(ctx, 'appleContainer.system.status', showOverview);
  register(ctx, 'appleContainer.system.df', showOverview);

  register(ctx, 'appleContainer.system.logs', async () => {
    await openCliTerminal(cli, vscode.l10n.t('container system logs'), [
      'system',
      'logs',
      '--follow',
    ]);
  });

  register(ctx, 'appleContainer.system.menu', async () => {
    const running = ctx.monitor.state.kind === 'running';
    const items: (vscode.QuickPickItem & {command: string})[] = [
      running
        ? {
            label: `$(debug-stop) ${vscode.l10n.t('Stop System Service')}`,
            command: 'appleContainer.system.stop',
          }
        : {
            label: `$(debug-start) ${vscode.l10n.t('Start System Service')}`,
            command: 'appleContainer.system.start',
          },
      {
        label: `$(dashboard) ${vscode.l10n.t('Show System Overview')}`,
        command: 'appleContainer.system.status',
      },
      {
        label: `$(output) ${vscode.l10n.t('Show System Logs')}`,
        command: 'appleContainer.system.logs',
      },
      {
        label: `$(refresh) ${vscode.l10n.t('Refresh')}`,
        command: 'appleContainer.refresh',
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Apple Container',
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  });
}
