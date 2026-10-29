// Browses a running container's filesystem in a quick pick, listing directories with `ls -1Ap` through exec

import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';
import { joinContainerPath, parentContainerPath, parseListing, type ContainerEntry } from '../utils/files';

type Mode = 'directory' | 'any';

interface PickItem extends vscode.QuickPickItem {
  action: 'select' | 'up' | 'open' | 'pick';
  path: string;
}

async function list(cli: ContainerCli, id: string, dir: string): Promise<ContainerEntry[]> {
  // $1 keeps the path out of the script, so spaces and quotes need no escaping
  const out = await cli.run(['exec', id, 'sh', '-c', 'cd -- "$1" && ls -1Ap', 'sh', dir], { timeoutMs: 15_000 });
  return parseListing(out);
}

/**
 * Lets the user walk the container filesystem. In 'directory' mode only a directory can be chosen;
 * in 'any' mode a file can be picked directly and the current directory can be chosen as well.
 * Typing an absolute path and pressing Enter jumps there. Falls back to an input box when the image has no shell.
 */
export async function pickContainerPath(
  cli: ContainerCli,
  id: string,
  options: { title: string; start: string; mode: Mode; selectLabel: string },
): Promise<string | undefined> {
  try {
    await list(cli, id, options.start);
  } catch {
    const typed = await vscode.window.showInputBox({
      title: options.title,
      prompt: vscode.l10n.t('Absolute path inside the container'),
      value: options.start,
      ignoreFocusOut: true,
    });
    return typed?.trim() || undefined;
  }

  const qp = vscode.window.createQuickPick<PickItem>();
  qp.ignoreFocusOut = true;
  qp.matchOnDescription = true;
  qp.placeholder = vscode.l10n.t('Filter, or type an absolute path and press Enter');

  /** Resolves false when dir cannot be listed, e.g. because it is a file */
  const show = async (dir: string): Promise<boolean> => {
    qp.busy = true;
    qp.title = `${options.title} — ${dir}`;
    qp.value = '';
    try {
      const entries = await list(cli, id, dir);
      const items: PickItem[] = [{ label: `$(check) ${options.selectLabel}`, description: dir, action: 'select', path: dir, alwaysShow: true }];
      if (dir !== '/') {
        items.push({ label: '$(arrow-up) ..', action: 'up', path: parentContainerPath(dir), alwaysShow: true });
      }
      for (const entry of entries) {
        const full = joinContainerPath(dir, entry.name);
        if (entry.directory) {
          items.push({ label: `$(folder) ${entry.name}`, action: 'open', path: full });
        } else if (options.mode === 'any') {
          items.push({ label: `$(file) ${entry.name}`, action: 'pick', path: full });
        }
      }
      qp.items = items;
      return true;
    } catch {
      qp.items = [{ label: `$(error) ${vscode.l10n.t('Cannot list {0}', dir)}`, action: 'up', path: parentContainerPath(dir) }];
      return false;
    } finally {
      qp.busy = false;
    }
  };

  return new Promise<string | undefined>((resolve) => {
    let done = false;
    const finish = (value: string | undefined) => {
      if (!done) {
        done = true;
        resolve(value);
        qp.dispose();
      }
    };
    qp.onDidAccept(() => {
      const typed = qp.value.trim();
      if (typed.startsWith('/')) {
        const target = typed.replace(/(.)\/+$/, '$1');
        // A typed path that is not a directory is taken as a file where files are allowed
        void show(target).then((listed) => {
          if (!listed && options.mode === 'any') {
            finish(target);
          }
        });
        return;
      }
      const item = qp.selectedItems[0];
      if (!item) {
        return;
      }
      if (item.action === 'select' || item.action === 'pick') {
        finish(item.path);
      } else {
        void show(item.path);
      }
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
    void show(options.start);
  });
}
