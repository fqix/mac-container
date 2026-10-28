import * as vscode from 'vscode';

import type { VolumeNode } from '../views/volumes';
import { ask, CommandContext, confirm, register, selection, showOutput, withProgress } from './common';

export function registerVolumeCommands(ctx: CommandContext): void {
  const { cli } = ctx;

  register(ctx, 'appleContainer.volume.create', async () => {
    const name = await ask({ title: vscode.l10n.t('Create Volume'), prompt: vscode.l10n.t('Volume name') });
    if (!name) {
      return;
    }
    const size = await ask({
      title: vscode.l10n.t('Create Volume'),
      prompt: vscode.l10n.t('Size (optional), e.g. 10G'),
      allowEmpty: true,
      validateInput: (v) => (!v.trim() || /^\d+[KMGTP]?$/i.test(v.trim()) ? undefined : vscode.l10n.t('Use a number with an optional K, M, G, T or P suffix')),
    });
    if (size === undefined) {
      return;
    }
    await cli.run(['volume', 'create', ...(size ? ['-s', size] : []), name]);
    ctx.views.volumes.refresh();
  });

  register(ctx, 'appleContainer.volume.inspect', async (node?: VolumeNode) => {
    if (node) {
      await ctx.documents.open(`/volume/${node.resource.name}.json`, () => cli.inspect('volume', [node.resource.name]));
    }
  });

  register(ctx, 'appleContainer.volume.delete', async (node?: VolumeNode, nodes?: VolumeNode[]) => {
    const items = selection(node, nodes);
    if (!items.length) {
      return;
    }
    const list = items.map((v) => v.name).join(', ');
    if (
      !(await confirm(
        vscode.l10n.t('Delete volume {0}?', list),
        vscode.l10n.t('Delete'),
        vscode.l10n.t('All data in the volume will be permanently lost.'),
      ))
    ) {
      return;
    }
    await withProgress(vscode.l10n.t('Deleting {0}...', list), () => cli.run(['volume', 'delete', ...items.map((v) => v.name)]));
    ctx.views.volumes.refresh();
  });

  register(ctx, 'appleContainer.volume.prune', async () => {
    if (
      !(await confirm(
        vscode.l10n.t('Remove all volumes not used by any container?'),
        vscode.l10n.t('Prune'),
        vscode.l10n.t('All data in the volume will be permanently lost.'),
      ))
    ) {
      return;
    }
    const out = await cli.run(['volume', 'prune']);
    showOutput(out, vscode.l10n.t('Unused volumes removed.'));
    ctx.views.volumes.refresh();
  });
}
