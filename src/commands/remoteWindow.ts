// Commands of a dev container's Remote-SSH window. The extension runs on the UI side, so it is active there too,
// but the window is attached to the container: rebuilding it has to happen in a local window on its folder.

import {mkdir, readFile, writeFile} from 'fs/promises';
import * as path from 'path';

import * as vscode from 'vscode';

import {ContainerCli} from '../services/cli';
import {LABEL_CONFIG_FILE, LABEL_LOCAL_FOLDER} from '../services/devcontainer';
import {
  devContainerLogFile,
  PENDING_ACTION_FILE,
  type PendingAction,
} from '../services/devcontainerCli';
import {containerOfAuthority} from '../services/remoteSsh';
import {showError} from '../utils/i18n';
import {DOCUMENT_SCHEME, ReadonlyDocumentProvider} from '../ui/documents';

/** Context key for the commands and the remote indicator menu entries */
const IN_DEV_CONTAINER_KEY = 'appleContainer.inDevContainer';

export async function writePendingAction(
  extension: vscode.ExtensionContext,
  pending: PendingAction | undefined,
): Promise<void> {
  const dir = extension.globalStorageUri.fsPath;
  await mkdir(dir, {recursive: true});
  await writeFile(
    path.join(dir, PENDING_ACTION_FILE),
    JSON.stringify(pending ?? null),
  );
}

export async function readPendingAction(
  extension: vscode.ExtensionContext,
): Promise<PendingAction | undefined> {
  try {
    const data = JSON.parse(
      await readFile(
        path.join(extension.globalStorageUri.fsPath, PENDING_ACTION_FILE),
        'utf8',
      ),
    );
    return data ?? undefined;
  } catch {
    return undefined;
  }
}

interface DevContainerWindow {
  containerId: string;
  workspaceFolder: string;
  configFile: string;
}

/** The dev container this Remote-SSH window is attached to, if the extension created it */
async function attachedDevContainer(
  cli: ContainerCli,
): Promise<DevContainerWindow | undefined> {
  const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority;
  if (vscode.env.remoteName !== 'ssh-remote' || !authority) {
    return undefined;
  }
  const containers = await cli.listContainers();
  const id = containerOfAuthority(
    authority,
    containers.map(c => c.id),
  );
  const container = containers.find(c => c.id === id);
  const workspaceFolder = container?.labels[LABEL_LOCAL_FOLDER];
  const configFile = container?.labels[LABEL_CONFIG_FILE];
  return container && workspaceFolder && configFile
    ? {containerId: container.id, workspaceFolder, configFile}
    : undefined;
}

const LOOKUP_ATTEMPTS = 12;
const LOOKUP_RETRY_MS = 5_000;

async function lookUpWithRetry<T>(
  lookUp: () => Promise<T | undefined>,
): Promise<T | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await lookUp();
    } catch {
      if (attempt >= LOOKUP_ATTEMPTS) {
        return undefined;
      }
      await new Promise(resolve => setTimeout(resolve, LOOKUP_RETRY_MS));
    }
  }
}

export function registerRemoteWindowCommands(
  extension: vscode.ExtensionContext,
): void {
  const config = () => vscode.workspace.getConfiguration('appleContainer');
  const cli = new ContainerCli(() => config().get<string>('path', 'container'));
  const documents = new ReadonlyDocumentProvider();
  extension.subscriptions.push(
    documents,
    vscode.workspace.registerTextDocumentContentProvider(
      DOCUMENT_SCHEME,
      documents,
    ),
  );

  // The commands only show once it is found. The service may still be starting when the window opens, so a failed
  // lookup is retried for a while; a successful one that finds no dev container is final.
  const attached = lookUpWithRetry(() => attachedDevContainer(cli));
  void attached.then(target =>
    vscode.commands.executeCommand(
      'setContext',
      IN_DEV_CONTAINER_KEY,
      !!target,
    ),
  );

  const command = (
    id: string,
    handler: (target: DevContainerWindow) => Thenable<unknown>,
  ) =>
    extension.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          const target = await attached;
          if (!target) {
            throw new Error(
              vscode.l10n.t(
                'This window is not attached to a dev container created by Apple Container.',
              ),
            );
          }
          await handler(target);
        } catch (error) {
          showError(error);
        }
      }),
    );

  const reopenLocally = (target: DevContainerWindow) =>
    vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(target.workspaceFolder),
      {
        forceReuseWindow: true,
      },
    );

  // The container is deleted while rebuilding, which ends this window's connection; so the window switches to the
  // local folder first, and the local window rebuilds and reopens the container in place (see runPendingAction)
  const rebuild =
    (action: PendingAction['action']) => async (target: DevContainerWindow) => {
      const confirm = vscode.l10n.t('Rebuild');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Rebuild the dev container {0}?', target.containerId),
        {
          modal: true,
          detail: vscode.l10n.t(
            'The window reopens the folder locally while the container is deleted and created again, then connects to the new container. Files outside the workspace folder and mounts are lost.',
          ),
        },
        confirm,
      );
      if (answer !== confirm) {
        return;
      }
      await writePendingAction(extension, {
        action,
        workspaceFolder: target.workspaceFolder,
        configFile: target.configFile,
        at: Date.now(),
      });
      await reopenLocally(target);
      // Still here: the folder is open in another window, which VS Code focused and which runs the rebuild.
      // This window would only lose its connection when the container is deleted.
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    };

  command('appleContainer.remote.reopenLocally', reopenLocally);
  command('appleContainer.remote.rebuild', rebuild('rebuild'));
  command('appleContainer.remote.rebuildNoCache', rebuild('rebuildNoCache'));
  command('appleContainer.remote.showLog', async target => {
    const file = devContainerLogFile(
      extension.globalStorageUri.fsPath,
      target.containerId,
    );
    await documents.open(
      `/${target.containerId}.log`,
      () =>
        readFile(file, 'utf8').catch(() =>
          vscode.l10n.t(
            'No log was recorded for {0}. The log is written when the dev container is created or opened with Apple Container.',
            target.containerId,
          ),
        ),
      'log',
    );
  });
}
