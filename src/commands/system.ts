import * as vscode from 'vscode';

import { openCliTerminal, runCliTask } from '../terminal';
import { CommandContext, confirm, register, withProgress } from './common';

export function registerSystemCommands(ctx: CommandContext): void {
  const { cli } = ctx;

  register(ctx, 'appleContainer.system.start', async () => {
    // The first start may prompt to install the default kernel, so run it in a task terminal the user can type into
    await runCliTask(cli, vscode.l10n.t('Start container system service'), ['system', 'start']);
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
    await withProgress(vscode.l10n.t('Stopping container system service...'), () => cli.run(['system', 'stop'], { timeoutMs: 120_000 }));
    await ctx.refreshAll();
  });

  register(ctx, 'appleContainer.system.status', async () => {
    await ctx.documents.open('/system/status.json', async () => JSON.stringify(await cli.json(['system', 'status']), null, 2));
  });

  register(ctx, 'appleContainer.system.df', async () => {
    await ctx.documents.open('/system/df.json', async () => JSON.stringify(await cli.systemDf(), null, 2));
  });

  register(ctx, 'appleContainer.system.logs', async () => {
    await openCliTerminal(cli, vscode.l10n.t('container system logs'), ['system', 'logs', '--follow']);
  });

  register(ctx, 'appleContainer.system.menu', async () => {
    const running = ctx.monitor.state.kind === 'running';
    const items: (vscode.QuickPickItem & { command: string })[] = [
      running
        ? { label: `$(debug-stop) ${vscode.l10n.t('Stop System Service')}`, command: 'appleContainer.system.stop' }
        : { label: `$(debug-start) ${vscode.l10n.t('Start System Service')}`, command: 'appleContainer.system.start' },
      { label: `$(info) ${vscode.l10n.t('Show System Status')}`, command: 'appleContainer.system.status' },
      { label: `$(database) ${vscode.l10n.t('Show Disk Usage')}`, command: 'appleContainer.system.df' },
      { label: `$(output) ${vscode.l10n.t('Show System Logs')}`, command: 'appleContainer.system.logs' },
      { label: `$(refresh) ${vscode.l10n.t('Refresh')}`, command: 'appleContainer.refresh' },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Apple Container' });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  });
}
