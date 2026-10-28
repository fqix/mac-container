import * as os from 'os';
import * as path from 'path';
import { access, readFile } from 'fs/promises';

import * as vscode from 'vscode';

import {
  CONFIG_FILE,
  DEFAULT_SSHD,
  INCLUDE_LINE,
  NoPackageManagerError,
  type SshHost,
  SshdMissingError,
  SshUserMissingError,
  ensureClientKey,
  hostAlias,
  installSshd,
  isIncluded,
  prepareContainer,
  renderConfig,
  writeConfig,
} from '../services/remoteSsh';
import { describeError } from '../utils/i18n';
import type { ContainerNode } from '../views/containers';
import { CommandContext, ask, register, withProgress } from './common';

/** globalState keys: sshd path and login user per container, last opened folder per user@container */
const HOSTS_KEY = 'remoteSsh.hosts';
const FOLDERS_KEY = 'remoteSsh.folders';

const INSTALL_HINT = [
  'apk add openssh-server',
  'apt-get update && apt-get install -y openssh-server',
  'dnf install -y openssh-server',
].join('\n');

export function registerRemoteSshCommands(ctx: CommandContext): void {
  const { cli } = ctx;
  const state = ctx.extension.globalState;

  register(ctx, 'appleContainer.container.openRemoteSsh', async (node?: ContainerNode) => {
    if (!node) {
      return;
    }
    const id = node.resource.id;
    if (!(await ensureRemoteSshExtension())) {
      return;
    }
    // An explicit setting wins; otherwise log in as the container's own process user (image USER or --user)
    const configured = vscode.workspace.getConfiguration('appleContainer').get<string>('sshUser', '').trim();
    const user = configured || node.resource.user || 'root';

    const prepare = () =>
      withProgress(vscode.l10n.t('Preparing SSH access to {0}...', id), async () => {
        const publicKey = await ensureClientKey();
        const result = await prepareContainer(cli, id, user, publicKey);

        const saved = { ...state.get<Record<string, SshHost>>(HOSTS_KEY, {}), [id]: { id, sshd: result.sshd, user: result.user } };
        const containers = await cli.listContainers();
        const known = new Set(containers.map((c) => c.id));
        for (const key of Object.keys(saved)) {
          if (!known.has(key)) {
            delete saved[key];
          }
        }
        await state.update(HOSTS_KEY, saved);
        // Containers never prepared get defaults; they connect once sshd and the key are set up
        const hosts = containers.map((c) => saved[c.id] ?? { id: c.id, sshd: DEFAULT_SSHD, user: c.user?.split(':')[0] || 'root' });
        await writeConfig(renderConfig(hosts, await cli.executable()));
        return result;
      });

    let prepared;
    try {
      try {
        prepared = await prepare();
      } catch (error) {
        if (!(error instanceof SshdMissingError)) {
          throw error;
        }
        try {
          await withProgress(vscode.l10n.t('Installing openssh-server in {0}...', id), () => installSshd(cli, id));
        } catch (installError) {
          await reportMissingSshd(id, installError);
          return;
        }
        prepared = await prepare();
      }
    } catch (error) {
      if (error instanceof SshUserMissingError) {
        void vscode.window.showErrorMessage(vscode.l10n.t('User {0} does not exist in container {1}.', error.user, id));
        return;
      }
      throw error;
    }

    if (!(await ensureIncluded())) {
      return;
    }

    // Remembered per login, since another user starts in another home
    const folderKey = `${prepared.user}@${id}`;
    const folders = state.get<Record<string, string>>(FOLDERS_KEY, {});
    const folder = await ask({
      title: vscode.l10n.t('Open {0} over Remote-SSH', id),
      prompt: vscode.l10n.t('Folder inside the container'),
      value: folders[folderKey] ?? prepared.home,
    });
    if (!folder) {
      return;
    }
    await state.update(FOLDERS_KEY, { ...folders, [folderKey]: folder });
    const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${hostAlias(id)}`, path: folder });
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  });
}

/** VS Code ships ms-vscode-remote.remote-ssh, Cursor anysphere.remote-ssh, VSCodium-based editors open-remote-ssh */
async function ensureRemoteSshExtension(): Promise<boolean> {
  if (vscode.extensions.all.some((e) => /remote-ssh$/i.test(e.id))) {
    return true;
  }
  const install = vscode.l10n.t('Find Extension');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t('Opening a container over SSH needs the Remote - SSH extension.'),
    install,
  );
  if (answer === install) {
    await vscode.commands.executeCommand('workbench.extensions.search', 'remote-ssh');
  }
  return false;
}

/** Automatic installation failed (no package manager, no network, ...): leave it to the user */
async function reportMissingSshd(id: string, cause: unknown): Promise<void> {
  const copy = vscode.l10n.t('Copy Install Command');
  const shell = vscode.l10n.t('Attach Shell');
  const reason =
    cause instanceof NoPackageManagerError ? vscode.l10n.t('No supported package manager was found.') : describeError(cause);
  const answer = await vscode.window.showErrorMessage(
    vscode.l10n.t('Could not install openssh-server in container {0}.', id),
    {
      modal: true,
      detail: vscode.l10n.t('{0}\n\nInstall it inside the container yourself, for example:\n{1}', reason, INSTALL_HINT),
    },
    copy,
    shell,
  );
  if (answer === copy) {
    await vscode.env.clipboard.writeText(INSTALL_HINT);
  } else if (answer === shell) {
    await vscode.commands.executeCommand('appleContainer.container.exec', { resource: { id } });
  }
}

/** Remote-SSH reads ~/.ssh/config (or remote.SSH.configFile); the extension never edits it, the user adds the Include line */
async function ensureIncluded(): Promise<boolean> {
  const configured = vscode.workspace.getConfiguration('remote.SSH').get<string>('configFile', '').trim();
  const userConfig = configured ? configured.replace(/^~(?=\/)/, os.homedir()) : path.join(os.homedir(), '.ssh', 'config');
  let text = '';
  try {
    text = await readFile(userConfig, 'utf8');
  } catch {
    // A missing config simply has no Include
  }
  if (isIncluded(text)) {
    return true;
  }
  const copy = vscode.l10n.t('Copy Include Line');
  const open = vscode.l10n.t('Open SSH Config');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t('Add the container hosts to your SSH config'),
    {
      modal: true,
      detail: vscode.l10n.t(
        'Add this line at the top of {0}, before any Host entry, then run the command again:\n\n{1}\n\nThe extension writes its hosts to {2} and does not modify your own SSH config.',
        userConfig,
        INCLUDE_LINE,
        CONFIG_FILE,
      ),
    },
    copy,
    open,
  );
  if (answer === copy) {
    await vscode.env.clipboard.writeText(INCLUDE_LINE + '\n');
  } else if (answer === open) {
    const uri = vscode.Uri.file(userConfig);
    const exists = text.length > 0 || (await fileExists(userConfig));
    await vscode.window.showTextDocument(exists ? uri : uri.with({ scheme: 'untitled' }));
    await vscode.env.clipboard.writeText(INCLUDE_LINE + '\n');
  }
  return false;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
