import * as vscode from 'vscode';

import { ContainerFormPanel } from '../panels/containerFormPanel';
import { StatsPanel } from '../panels/statsPanel';
import { openCliTerminal } from '../ui/terminal';
import type { ContainerSummary } from '../models/types';
import type { ContainerNode } from '../views/containers';
import { CommandContext, confirm, register, selection, showOutput, withProgress } from './common';

export function registerContainerCommands(ctx: CommandContext): void {
  const { cli } = ctx;
  const refresh = () => ctx.refreshAll();

  register(ctx, 'appleContainer.container.start', async (node?: ContainerNode, nodes?: ContainerNode[]) => {
    const items = selection(node, nodes);
    await withProgress(vscode.l10n.t('Starting {0}...', names(items)), async () => {
      // start accepts a single container only
      for (const c of items) {
        await cli.run(['start', c.id]);
      }
    });
    await refresh();
  });

  register(ctx, 'appleContainer.container.stop', async (node?: ContainerNode, nodes?: ContainerNode[]) => {
    const items = selection(node, nodes);
    await withProgress(vscode.l10n.t('Stopping {0}...', names(items)), () => cli.run(['stop', ...items.map((c) => c.id)]));
    await refresh();
  });

  register(ctx, 'appleContainer.container.restart', async (node?: ContainerNode, nodes?: ContainerNode[]) => {
    const items = selection(node, nodes);
    await withProgress(vscode.l10n.t('Restarting {0}...', names(items)), async () => {
      await cli.run(['stop', ...items.map((c) => c.id)]);
      for (const c of items) {
        await cli.run(['start', c.id]);
      }
    });
    await refresh();
  });

  register(ctx, 'appleContainer.container.kill', async (node?: ContainerNode, nodes?: ContainerNode[]) => {
    const items = selection(node, nodes);
    if (!(await confirm(vscode.l10n.t('Kill {0}?', names(items)), vscode.l10n.t('Kill')))) {
      return;
    }
    await cli.run(['kill', ...items.map((c) => c.id)]);
    await refresh();
  });

  register(ctx, 'appleContainer.container.delete', async (node?: ContainerNode, nodes?: ContainerNode[]) => {
    const items = selection(node, nodes);
    if (!items.length) {
      return;
    }
    const running = items.filter((c) => c.state === 'running');
    const detail = running.length
      ? vscode.l10n.t('Running containers will be stopped first: {0}', names(running))
      : undefined;
    if (!(await confirm(vscode.l10n.t('Delete {0}?', names(items)), vscode.l10n.t('Delete'), detail))) {
      return;
    }
    const args = ['delete', ...(running.length ? ['--force'] : []), ...items.map((c) => c.id)];
    await withProgress(vscode.l10n.t('Deleting {0}...', names(items)), () => cli.run(args));
    await refresh();
  });

  register(ctx, 'appleContainer.container.logs', async (node?: ContainerNode) => {
    if (!node) {
      return;
    }
    const tail = vscode.workspace.getConfiguration('appleContainer').get<number>('logTail', 200);
    const args = ['logs', '--follow', ...(tail > 0 ? ['-n', String(tail)] : []), node.resource.id];
    await openCliTerminal(cli, vscode.l10n.t('Logs: {0}', node.resource.id), args);
  });

  register(ctx, 'appleContainer.container.bootLogs', async (node?: ContainerNode) => {
    if (node) {
      await openCliTerminal(cli, vscode.l10n.t('Boot Logs: {0}', node.resource.id), ['logs', '--boot', node.resource.id]);
    }
  });

  register(ctx, 'appleContainer.container.exec', async (node?: ContainerNode) => {
    if (!node) {
      return;
    }
    const shell = vscode.workspace.getConfiguration('appleContainer').get<string>('execShell', '/bin/sh');
    await openCliTerminal(cli, `${node.resource.id}: ${shell}`, ['exec', '--interactive', '--tty', node.resource.id, shell]);
  });

  register(ctx, 'appleContainer.container.inspect', async (node?: ContainerNode) => {
    if (node) {
      await ctx.documents.open(`/container/${node.resource.id}.json`, () => cli.inspect('container', [node.resource.id]));
    }
  });

  register(ctx, 'appleContainer.container.stats', (node?: ContainerNode, nodes?: ContainerNode[]) => {
    for (const c of selection(node, nodes)) {
      StatsPanel.show(ctx.extension.extensionUri, cli, c.id);
    }
  });

  register(ctx, 'appleContainer.container.edit', (node?: ContainerNode) => {
    if (node) {
      ContainerFormPanel.showEdit(ctx.extension.extensionUri, cli, node.resource.id, refresh);
    }
  });

  register(ctx, 'appleContainer.container.copyId', async (node?: ContainerNode) => {
    if (node) {
      await vscode.env.clipboard.writeText(node.resource.id);
    }
  });

  register(ctx, 'appleContainer.container.copyIp', async (node?: ContainerNode) => {
    if (node?.resource.ipv4) {
      await vscode.env.clipboard.writeText(node.resource.ipv4);
    } else {
      void vscode.window.showWarningMessage(vscode.l10n.t('This container has no IP address.'));
    }
  });

  register(ctx, 'appleContainer.container.prune', async () => {
    if (!(await confirm(vscode.l10n.t('Remove all stopped containers?'), vscode.l10n.t('Prune')))) {
      return;
    }
    const out = await withProgress(vscode.l10n.t('Pruning containers...'), () => cli.run(['prune']));
    showOutput(out, vscode.l10n.t('Stopped containers removed.'));
    await refresh();
  });
}

function names(items: ContainerSummary[]): string {
  return items.map((c) => c.id).join(', ');
}
