import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import type { ContainerSummary } from '../models/types';
import { pickContainerPath } from '../ui/containerPathPicker';
import { uniqueLocalPath } from '../utils/files';
import type { ContainerNode } from '../views/containers';
import { CommandContext, isLocal, register, withProgress } from './common';

/** workspaceState key: last container directory used per container */
const LAST_DIR_KEY = 'files.lastDirectory';

/** Lets tests and the explorer menu skip the pickers */
export interface UploadOptions {
  sources?: vscode.Uri[];
  destination?: string;
}

export interface DownloadOptions {
  source?: string;
  targetDirectory?: vscode.Uri;
}

export function registerFileCommands(ctx: CommandContext): void {
  const { cli } = ctx;
  const state = ctx.extension.workspaceState;
  const lastDir = (c: ContainerSummary) => state.get<Record<string, string>>(LAST_DIR_KEY, {})[c.id] ?? c.workdir ?? '/';
  const remember = (c: ContainerSummary, dir: string) =>
    state.update(LAST_DIR_KEY, { ...state.get<Record<string, string>>(LAST_DIR_KEY, {}), [c.id]: dir });

  const upload = async (container: ContainerSummary, options: UploadOptions = {}) => {
    const sources =
      options.sources ??
      (await vscode.window.showOpenDialog({
        title: vscode.l10n.t('Upload to {0}', container.id),
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: vscode.l10n.t('Upload'),
      }));
    if (!sources?.length || !sources.every(isLocal)) {
      return;
    }
    const destination =
      options.destination ??
      (await pickContainerPath(cli, container.id, {
        title: vscode.l10n.t('Upload to {0}', container.id),
        start: lastDir(container),
        mode: 'directory',
        selectLabel: vscode.l10n.t('Upload here'),
      }));
    if (!destination) {
      return;
    }
    await remember(container, destination);
    const names = sources.map((s) => path.basename(s.fsPath)).join(', ');
    await withProgress(vscode.l10n.t('Uploading {0} to {1}:{2}...', names, container.id, destination), async () => {
      await cli.run(['exec', container.id, 'mkdir', '-p', destination]);
      for (const source of sources) {
        // A trailing slash makes cp put files and folders inside the destination directory
        await cli.run(['copy', source.fsPath, `${container.id}:${destination.replace(/\/?$/, '/')}`], { timeoutMs: 60 * 60_000 });
      }
    });
    void vscode.window.showInformationMessage(vscode.l10n.t('Uploaded {0} to {1}:{2}.', names, container.id, destination));
  };

  register(ctx, 'appleContainer.container.upload', async (node?: ContainerNode, options?: UploadOptions) => {
    if (node) {
      await upload(node.resource, options);
    }
  });

  // Explorer context menu: the clicked file(s), then a running container to upload to
  register(ctx, 'appleContainer.file.uploadToContainer', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const sources = uris?.length ? uris : uri ? [uri] : undefined;
    const running = (await cli.listContainers()).filter((c) => c.state === 'running' && !c.builder);
    if (!running.length) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No running containers.'));
      return;
    }
    const picked =
      running.length === 1
        ? running[0]
        : (
            await vscode.window.showQuickPick(
              running.map((c) => ({ label: c.id, description: c.image, container: c })),
              { title: vscode.l10n.t('Select a container to upload to') },
            )
          )?.container;
    if (picked) {
      await upload(picked, { sources });
    }
  });

  register(ctx, 'appleContainer.container.download', async (node?: ContainerNode, options: DownloadOptions = {}) => {
    if (!node) {
      return;
    }
    const container = node.resource;
    const source =
      options.source ??
      (await pickContainerPath(cli, container.id, {
        title: vscode.l10n.t('Download from {0}', container.id),
        start: lastDir(container),
        mode: 'any',
        selectLabel: vscode.l10n.t('Download this folder'),
      }));
    if (!source) {
      return;
    }
    await remember(container, path.posix.dirname(source));
    const targetDirectory =
      options.targetDirectory ??
      (
        await vscode.window.showOpenDialog({
          title: vscode.l10n.t('Save {0} to', path.posix.basename(source) || source),
          canSelectFiles: false,
          canSelectFolders: true,
          openLabel: vscode.l10n.t('Save Here'),
        })
      )?.[0];
    if (!targetDirectory || !isLocal(targetDirectory)) {
      return;
    }
    const name = path.posix.basename(source) || container.id;
    const target = uniqueLocalPath(targetDirectory.fsPath, name, fs.existsSync);
    await withProgress(vscode.l10n.t('Downloading {0}:{1}...', container.id, source), () =>
      cli.run(['copy', `${container.id}:${source}`, target], { timeoutMs: 60 * 60_000 }),
    );
    const reveal = vscode.l10n.t('Reveal in Finder');
    void vscode.window.showInformationMessage(vscode.l10n.t('Downloaded to {0}.', target), reveal).then((answer) => {
      if (answer === reveal) {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
      }
    });
  });
}
