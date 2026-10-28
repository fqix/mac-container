import * as path from 'path';
import * as vscode from 'vscode';

import { resolveCliPath } from '../cli';
import { COMPOSE_FILE_NAMES, composeProjectName, isComposeFileName } from '../compose';
import { runTask } from '../terminal';
import type { ContainerSummary } from '../types';
import type { ComposeProjectNode } from '../views/containers';
import { CommandContext, confirm, register, withProgress } from './common';

const COMPOSE_GLOB = `**/{${COMPOSE_FILE_NAMES.join(',')}}`;

export function registerComposeCommands(ctx: CommandContext): void {
  const { cli } = ctx;
  const members = (node?: ComposeProjectNode): ContainerSummary[] => node?.project.containers ?? [];

  register(ctx, 'appleContainer.compose.start', async (node?: ComposeProjectNode) => {
    const stopped = members(node).filter((c) => c.state !== 'running');
    await withProgress(vscode.l10n.t('Starting {0}...', node?.project.name ?? ''), async () => {
      // start accepts a single container only
      for (const c of stopped) {
        await cli.run(['start', c.id]);
      }
    });
    await ctx.refreshAll();
  });

  register(ctx, 'appleContainer.compose.stop', async (node?: ComposeProjectNode) => {
    const running = members(node).filter((c) => c.state === 'running');
    if (running.length) {
      await withProgress(vscode.l10n.t('Stopping {0}...', node!.project.name), () => cli.run(['stop', ...running.map((c) => c.id)]));
    }
    await ctx.refreshAll();
  });

  register(ctx, 'appleContainer.compose.restart', async (node?: ComposeProjectNode) => {
    const all = members(node);
    await withProgress(vscode.l10n.t('Restarting {0}...', node?.project.name ?? ''), async () => {
      const running = all.filter((c) => c.state === 'running');
      if (running.length) {
        await cli.run(['stop', ...running.map((c) => c.id)]);
      }
      for (const c of all) {
        await cli.run(['start', c.id]);
      }
    });
    await ctx.refreshAll();
  });

  register(ctx, 'appleContainer.compose.delete', async (node?: ComposeProjectNode) => {
    const all = members(node);
    if (!node || !all.length) {
      return;
    }
    if (
      !(await confirm(
        vscode.l10n.t('Delete all containers of compose project {0}?', node.project.name),
        vscode.l10n.t('Delete'),
        all.map((c) => c.id).join(', '),
      ))
    ) {
      return;
    }
    await withProgress(vscode.l10n.t('Deleting {0}...', node.project.name), () =>
      cli.run(['delete', '--force', ...all.map((c) => c.id)]),
    );
    await ctx.refreshAll();
  });

  // up / down need the compose file; from the explorer it is the clicked file, from the tree it is looked up in the workspace
  const composeAction = async (action: 'up' | 'down', target?: vscode.Uri | ComposeProjectNode) => {
    const file = target instanceof vscode.Uri ? target : await findComposeFile(target?.project.name);
    if (!file) {
      if (target && !(target instanceof vscode.Uri)) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('No compose file for project {0} was found in the workspace. Use Delete to remove its containers.', target.project.name),
        );
      }
      return;
    }
    if (file.scheme !== 'file') {
      void vscode.window.showErrorMessage(vscode.l10n.t('Only local files can be used. {0} is not on this Mac.', file.toString()));
      return;
    }
    const executable = await composeExecutable();
    if (!executable) {
      return;
    }
    if (action === 'down' && !(await confirm(vscode.l10n.t('Run compose down for {0}?', vscode.workspace.asRelativePath(file)), vscode.l10n.t('Down')))) {
      return;
    }
    // Run from the file's directory: container-compose derives the project name from the working directory
    const cwd = path.dirname(file.fsPath);
    const args = ['--file', file.fsPath, action, ...(action === 'up' ? ['--detach'] : [])];
    await runTask(`compose ${action}: ${vscode.workspace.asRelativePath(file)}`, executable, args, cwd);
    await ctx.refreshAll();
  };

  register(ctx, 'appleContainer.compose.up', (target?: vscode.Uri | ComposeProjectNode) => composeAction('up', target));
  register(ctx, 'appleContainer.compose.down', (target?: vscode.Uri | ComposeProjectNode) => composeAction('down', target));

  register(ctx, 'appleContainer.compose.openFile', async (node?: ComposeProjectNode) => {
    const file = await findComposeFile(node?.project.name);
    if (file) {
      await vscode.window.showTextDocument(file);
    } else if (node) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No compose file for project {0} was found in the workspace.', node.project.name));
    }
  });
}

async function composeExecutable(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('appleContainer').get<string>('composePath', 'container-compose');
  const executable = await resolveCliPath(configured);
  if (!executable) {
    const open = vscode.l10n.t('Open Settings');
    const answer = await vscode.window.showErrorMessage(
      vscode.l10n.t('container-compose not found: {0}. Install it with `brew install container-compose` or set appleContainer.composePath.', configured),
      open,
    );
    if (answer === open) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'appleContainer.composePath');
    }
  }
  return executable;
}

/** Without a project name: the only compose file, or one picked by the user. With one: the file producing that project. */
async function findComposeFile(project?: string): Promise<vscode.Uri | undefined> {
  const files = (await vscode.workspace.findFiles(COMPOSE_GLOB, '**/node_modules/**', 200)).filter((f) =>
    isComposeFileName(path.posix.basename(f.path)),
  );
  if (project === undefined) {
    if (files.length <= 1) {
      return files[0];
    }
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
      { title: vscode.l10n.t('Select a compose file') },
    );
    return picked?.uri;
  }
  for (const file of files) {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    if (composeProjectName(text, file.path) === project) {
      return file;
    }
  }
  return undefined;
}
