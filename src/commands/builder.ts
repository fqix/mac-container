// The BuildKit builder container: `container builder start / stop / delete`.
// Builds start it on demand, so these are for resetting a stuck builder or freeing its build cache.

import * as vscode from 'vscode';

import { runCliTask } from '../ui/terminal';
import { CommandContext, confirm, register, withProgress } from './common';

export function registerBuilderCommands(ctx: CommandContext): void {
  const { cli } = ctx;

  // No --cpus / --memory: builds pass none either, and the CLI recreates the builder whenever they differ
  const start = async () => {
    // A task, since the first start pulls the builder image
    await runCliTask(cli, vscode.l10n.t('Start Builder'), ['builder', 'start']);
    ctx.views.builder.refresh();
  };
  const stop = () => withProgress(vscode.l10n.t('Stopping the builder...'), () => cli.run(['builder', 'stop'], { timeoutMs: 120_000 }));

  register(ctx, 'appleContainer.builder.start', start);

  register(ctx, 'appleContainer.builder.stop', async () => {
    await stop();
    ctx.views.builder.refresh();
  });

  register(ctx, 'appleContainer.builder.restart', async () => {
    await stop();
    await start();
  });

  register(ctx, 'appleContainer.builder.delete', async () => {
    const ok = await confirm(
      vscode.l10n.t('Delete the builder?'),
      vscode.l10n.t('Delete'),
      vscode.l10n.t('Its build cache is removed. The next build creates the builder again.'),
    );
    if (!ok) {
      return;
    }
    await withProgress(vscode.l10n.t('Deleting the builder...'), () => cli.run(['builder', 'delete', '--force'], { timeoutMs: 120_000 }));
    ctx.views.builder.refresh();
  });
}
