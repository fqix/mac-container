import * as vscode from 'vscode';

import type { NetworkNode } from '../views/networks';
import { ask, CommandContext, confirm, register, selection, showOutput, withProgress } from './common';

export function registerNetworkCommands(ctx: CommandContext): void {
  const { cli } = ctx;

  register(ctx, 'appleContainer.network.create', async () => {
    const name = await ask({ title: vscode.l10n.t('Create Network'), prompt: vscode.l10n.t('Network name') });
    if (!name) {
      return;
    }
    const subnet = await ask({
      title: vscode.l10n.t('Create Network'),
      prompt: vscode.l10n.t('IPv4 subnet (optional), e.g. 192.168.100.0/24'),
      allowEmpty: true,
    });
    if (subnet === undefined) {
      return;
    }
    await cli.run(['network', 'create', ...(subnet ? ['--subnet', subnet] : []), name]);
    ctx.views.networks.refresh();
  });

  register(ctx, 'appleContainer.network.inspect', async (node?: NetworkNode) => {
    if (node) {
      await ctx.documents.open(`/network/${node.resource.id}.json`, () => cli.inspect('network', [node.resource.id]));
    }
  });

  register(ctx, 'appleContainer.network.delete', async (node?: NetworkNode, nodes?: NetworkNode[]) => {
    const items = selection(node, nodes).filter((n) => !n.builtin);
    if (!items.length) {
      return;
    }
    const list = items.map((n) => n.id).join(', ');
    if (!(await confirm(vscode.l10n.t('Delete network {0}?', list), vscode.l10n.t('Delete')))) {
      return;
    }
    await withProgress(vscode.l10n.t('Deleting {0}...', list), () => cli.run(['network', 'delete', ...items.map((n) => n.id)]));
    ctx.views.networks.refresh();
  });

  register(ctx, 'appleContainer.network.prune', async () => {
    if (!(await confirm(vscode.l10n.t('Remove all networks with no connected containers?'), vscode.l10n.t('Prune')))) {
      return;
    }
    const out = await cli.run(['network', 'prune']);
    showOutput(out, vscode.l10n.t('Unused networks removed.'));
    ctx.views.networks.refresh();
  });
}
