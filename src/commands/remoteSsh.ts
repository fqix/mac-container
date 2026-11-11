import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  DEFAULT_SSHD,
  InstallFailedError,
  type InstallRunner,
  NoPackageManagerError,
  type PrepareResult,
  type SshHost,
  SshdMissingError,
  SshUserMissingError,
  ensureClientKey,
  ensureUserConfigIncluded,
  hostAlias,
  installPackages,
  missingPackages,
  installSshd,
  prepareContainer,
  renderConfig,
  writeConfig,
  writeSessionEnvironment,
} from '../services/remoteSsh';
import {describeError} from '../utils/i18n';
import type {ContainerSummary} from '../models/types';
import {pickContainerPath} from '../ui/containerPathPicker';
import {StepTerminal} from '../ui/stepTerminal';
import type {ContainerNode} from '../views/containers';
import {CommandContext, register, withProgress} from './common';

/** globalState keys: sshd path and login user per container, last opened folder per user@container */
const HOSTS_KEY = 'remoteSsh.hosts';
const FOLDERS_KEY = 'remoteSsh.folders';

const INSTALL_HINT = [
  'apk add openssh-server',
  'apt-get update && apt-get install -y openssh-server',
  'dnf install -y openssh-server',
].join('\n');

export function registerRemoteSshCommands(ctx: CommandContext): void {
  register(
    ctx,
    'appleContainer.container.openRemoteSsh',
    async (node?: ContainerNode) => {
      if (node) {
        await openContainerOverSsh(ctx, node.resource);
      }
    },
  );
}

export interface SshOpenOptions {
  /** Login user; defaults to the appleContainer.sshUser setting, then the container's own user */
  user?: string;
  /** Folder to open; when missing the user is asked, starting from the last folder or the home directory */
  folder?: string;
  /** Extra variables for SSH sessions on top of the container environment (devcontainer.json remoteEnv) */
  remoteEnv?: Record<string, string>;
  /** Terminal to run package installs in, such as the dev container build's; one is opened when needed otherwise */
  terminal?: StepTerminal;
}

/**
 * Makes a running container reachable over SSH (sshd installed if needed, key authorized, host entry written)
 * and opens a folder in it with Remote-SSH in a new window. Resolves false when it stopped early.
 */
export async function openContainerOverSsh(
  ctx: CommandContext,
  container: Pick<ContainerSummary, 'id' | 'user'>,
  options: SshOpenOptions = {},
): Promise<boolean> {
  const {cli} = ctx;
  const state = ctx.extension.globalState;
  const id = container.id;
  if (!(await ensureRemoteSshExtension())) {
    return false;
  }
  // An explicit setting wins; otherwise log in as the container's own process user (image USER or --user)
  const configured = vscode.workspace
    .getConfiguration('appleContainer')
    .get<string>('sshUser', '')
    .trim();
  const user = options.user || configured || container.user || 'root';
  // Package installs show the package manager's output as steps in a terminal: the caller's, or one opened on first use
  let ownTerminal: StepTerminal | undefined;
  const install: InstallRunner = async ({args, packages, cancelArgs}) => {
    const terminal =
      options.terminal ??
      (ownTerminal ??= await StepTerminal.start(
        vscode.l10n.t('Prepare {0} for Remote-SSH', id),
      ));
    return terminal.run(
      vscode.l10n.t('Install {0}', packages.join(' ')),
      await cli.executable(),
      args,
      {onCancel: () => cli.run(cancelArgs, {timeoutMs: 15_000})},
    );
  };

  const prepare = () =>
    withProgress(
      vscode.l10n.t('Preparing SSH access to {0}...', id),
      async () => {
        const publicKey = await ensureClientKey();
        const result = await prepareContainer(cli, id, user, publicKey);

        const saved = {
          ...state.get<Record<string, SshHost>>(HOSTS_KEY, {}),
          [id]: {id, sshd: result.sshd, user: result.user},
        };
        const containers = (await cli.listContainers()).filter(c => !c.builder);
        const known = new Set(containers.map(c => c.id));
        for (const key of Object.keys(saved)) {
          if (!known.has(key)) {
            delete saved[key];
          }
        }
        await state.update(HOSTS_KEY, saved);
        // Containers never prepared get defaults; they connect once sshd and the key are set up
        const hosts = containers.map(
          c =>
            saved[c.id] ?? {
              id: c.id,
              sshd: DEFAULT_SSHD,
              user: c.user?.split(':')[0] || 'root',
            },
        );
        await writeConfig(renderConfig(hosts, await cli.executable()));
        return result;
      },
    );

  // Resolves undefined when Remote-SSH cannot be used, after telling the user why
  const prepareAndInstall = async (): Promise<PrepareResult | undefined> => {
    let result: PrepareResult;
    try {
      try {
        result = await prepare();
      } catch (error) {
        if (!(error instanceof SshdMissingError)) {
          throw error;
        }
        try {
          await installSshd(id, install);
        } catch (installError) {
          // Stopped by the user in the terminal: no error to report
          if (installError instanceof vscode.CancellationError) {
            throw installError;
          }
          await reportMissingSshd(id, installError);
          return undefined;
        }
        result = await prepare();
      }
    } catch (error) {
      if (error instanceof SshUserMissingError) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'User {0} does not exist in container {1}.',
            error.user,
            id,
          ),
        );
        return undefined;
      }
      throw error;
    }

    const packages = missingPackages(result);
    if (packages.length) {
      try {
        await installPackages(id, packages, install);
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          throw error;
        }
        const reason = installFailure(error);
        // Remote-SSH cannot connect at all without bash
        if (!result.bash) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              'Remote-SSH needs bash, which container {0} does not have, and installing it failed: {1}. Install bash in the container, or use an image that has it.',
              id,
              reason,
            ),
          );
          return undefined;
        }
        // The first connection still works: Remote-SSH downloads the server on this Mac and copies it in
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Could not install wget in container {0}: {1}. Remote-SSH cannot reconnect while its server is running there; install wget or curl in the container.',
            id,
            reason,
          ),
        );
      }
    }
    return result;
  };

  let prepared: PrepareResult | undefined;
  try {
    prepared = await prepareAndInstall();
  } catch (error) {
    if (!(error instanceof vscode.CancellationError)) {
      throw error;
    }
  } finally {
    // A terminal opened here only shows the installs; a failed one keeps the package manager's output
    ownTerminal?.end(prepared !== undefined);
  }
  if (!prepared) {
    return false;
  }

  await writeSessionEnvironment(cli, id, prepared.user, options.remoteEnv);
  await ensureIncluded();

  // Remembered per login, since another user starts in another home
  const folderKey = `${prepared.user}@${id}`;
  const folders = state.get<Record<string, string>>(FOLDERS_KEY, {});
  const folder =
    options.folder ??
    (await pickContainerPath(cli, id, {
      title: vscode.l10n.t('Open {0} over Remote-SSH', id),
      start: folders[folderKey] ?? prepared.home,
      mode: 'directory',
      selectLabel: vscode.l10n.t('Open this folder'),
      // Browse as the login user, so the folders shown are the ones the window can open
      user: prepared.user,
    }));
  if (!folder) {
    return false;
  }
  await state.update(FOLDERS_KEY, {...folders, [folderKey]: folder});
  const uri = vscode.Uri.from({
    scheme: 'vscode-remote',
    authority: `ssh-remote+${hostAlias(id)}`,
    path: folder,
  });
  await vscode.commands.executeCommand('vscode.openFolder', uri, {
    forceNewWindow: true,
  });
  return true;
}

/** VS Code ships ms-vscode-remote.remote-ssh, Cursor anysphere.remote-ssh, VSCodium-based editors open-remote-ssh */
async function ensureRemoteSshExtension(): Promise<boolean> {
  if (vscode.extensions.all.some(e => /remote-ssh$/i.test(e.id))) {
    return true;
  }
  const install = vscode.l10n.t('Find Extension');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Opening a container over SSH needs the Remote - SSH extension.',
    ),
    install,
  );
  if (answer === install) {
    await vscode.commands.executeCommand(
      'workbench.extensions.search',
      'remote-ssh',
    );
  }
  return false;
}

/** Why a package install in the container failed, for messages */
function installFailure(error: unknown): string {
  if (error instanceof NoPackageManagerError) {
    return vscode.l10n.t('No supported package manager was found.');
  }
  if (error instanceof InstallFailedError) {
    return vscode.l10n.t(
      'The package manager exited with code {0}; its output is in the terminal.',
      String(error.exitCode ?? '?'),
    );
  }
  return describeError(error);
}

/** Automatic installation failed (no package manager, no network, ...): leave it to the user */
async function reportMissingSshd(id: string, cause: unknown): Promise<void> {
  const copy = vscode.l10n.t('Copy Install Command');
  const shell = vscode.l10n.t('Attach Shell');
  const reason = installFailure(cause);
  const answer = await vscode.window.showErrorMessage(
    vscode.l10n.t('Could not install openssh-server in container {0}.', id),
    {
      modal: true,
      detail: vscode.l10n.t(
        '{0}\n\nInstall it inside the container yourself, for example:\n{1}',
        reason,
        INSTALL_HINT,
      ),
    },
    copy,
    shell,
  );
  if (answer === copy) {
    await vscode.env.clipboard.writeText(INSTALL_HINT);
  } else if (answer === shell) {
    await vscode.commands.executeCommand('appleContainer.container.exec', {
      resource: {id},
    });
  }
}

/** Connect the managed host entries to the SSH config used by Remote-SSH automatically. */
async function ensureIncluded(): Promise<void> {
  const configured = vscode.workspace
    .getConfiguration('remote.SSH')
    .get<string>('configFile', '')
    .trim();
  const userConfig = configured
    ? configured.replace(/^~(?=\/)/, os.homedir())
    : path.join(os.homedir(), '.ssh', 'config');
  await ensureUserConfigIncluded(userConfig);
}
