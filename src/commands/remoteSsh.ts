import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  containerTarget,
  DEFAULT_SSHD,
  type ExecTarget,
  InstallFailedError,
  type InstallRunner,
  machineHostAlias,
  machineTarget,
  NoPackageManagerError,
  POD_SSHD_ARGS,
  PodNotRootError,
  podHostAlias,
  type PodRef,
  type PrepareResult,
  podTarget,
  proxyCommand,
  type SshEntry,
  type SshHost,
  SshdMissingError,
  SshUserMissingError,
  ensureClientKey,
  ensureUserConfigIncluded,
  installPackages,
  missingPackages,
  installSshd,
  prepareTarget,
  renderConfig,
  withPrelude,
  writeConfig,
  writeSessionEnvironment,
} from '../services/remoteSsh';
import {writeConfigArgs} from '../services/cluster';
import {machineRunArgs} from '../services/machine';
import {describeError} from '../utils/i18n';
import type {ContainerSummary, MachineSummary} from '../models/types';
import {pickTargetPath} from '../ui/containerPathPicker';
import {StepTerminal} from '../ui/stepTerminal';
import type {ContainerNode} from '../views/containers';
import type {K8sItemTreeNode} from '../views/clusters';
import type {MachineNode} from '../views/machines';
import {CommandContext, register, withProgress} from './common';

/** globalState keys: sshd path and login user per container and machine, last opened folder per user@host, pod hosts */
const HOSTS_KEY = 'remoteSsh.hosts';
const MACHINE_HOSTS_KEY = 'remoteSsh.machineHosts';
const FOLDERS_KEY = 'remoteSsh.folders';
const POD_HOSTS_KEY = 'remoteSsh.podHosts';
/** Pods come and go; the config keeps the hosts of the most recently opened ones */
const MAX_POD_HOSTS = 20;

/** A pod host of the managed config, with the pod it reaches (to reuse its alias and drop it with its cluster) */
interface PodHost extends SshEntry, PodRef {
  /** When it was last opened, for MAX_POD_HOSTS */
  time: number;
}

const samePod = (a: PodRef, b: PodRef) =>
  a.cluster === b.cluster &&
  a.namespace === b.namespace &&
  a.pod === b.pod &&
  a.container === b.container;

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

  register(
    ctx,
    'appleContainer.machine.openRemoteSsh',
    async (node?: MachineNode) => {
      if (node) {
        await openMachineOverSsh(ctx, node.resource);
      }
    },
  );

  register(
    ctx,
    'appleContainer.k8s.openRemoteSsh',
    async (node?: K8sItemTreeNode) => {
      const ref = node?.resource;
      if (!ref || ref.item.resource !== 'pods' || !ref.item.namespace) {
        return;
      }
      const containers = ref.item.containers ?? [];
      const container =
        containers.length <= 1
          ? containers[0]
          : await vscode.window.showQuickPick(containers, {
              title: vscode.l10n.t('Open {0} over Remote-SSH', ref.item.name),
              placeHolder: vscode.l10n.t('Container'),
            });
      if (!container) {
        return;
      }
      await openPodOverSsh(ctx, {
        cluster: ref.cluster,
        namespace: ref.item.namespace,
        pod: ref.item.name,
        container,
        version: ref.version,
        multiContainer: containers.length > 1,
      });
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
  /** Open in the current window instead of a new one, e.g. when a dev container window rebuilds itself */
  reuseWindow?: boolean;
  /** Terminal to run package installs in, such as the dev container build's; one is opened when needed otherwise */
  terminal?: StepTerminal;
}

const configuredUser = () =>
  vscode.workspace
    .getConfiguration('appleContainer')
    .get<string>('sshUser', '')
    .trim();

/**
 * Makes a running container reachable over SSH (sshd installed if needed, key authorized, host entry written)
 * and opens a folder in it with Remote-SSH in a new window. Resolves false when it stopped early.
 */
export async function openContainerOverSsh(
  ctx: CommandContext,
  container: Pick<ContainerSummary, 'id' | 'user'>,
  options: SshOpenOptions = {},
): Promise<boolean> {
  const id = container.id;
  // An explicit setting wins; otherwise log in as the container's own process user (image USER or --user)
  const user = options.user || configuredUser() || container.user || 'root';
  return openOverSsh(
    ctx,
    containerTarget(ctx.cli, id),
    user,
    options,
    async result => {
      const state = ctx.extension.globalState;
      await state.update(HOSTS_KEY, {
        ...state.get<Record<string, SshHost>>(HOSTS_KEY, {}),
        [id]: {id, sshd: result.sshd, user: result.user},
      });
      await writeSshConfig(ctx);
    },
  );
}

/**
 * Opens a `container machine` with Remote-SSH, the same way as a container: sshd runs on the connection through
 * `container machine run`, which boots the machine first if it is stopped. The login user is the machine's account,
 * which matches the Mac user unless the machine was created with another one.
 */
export async function openMachineOverSsh(
  ctx: CommandContext,
  machine: Pick<MachineSummary, 'id'>,
): Promise<boolean> {
  const id = machine.id;
  const user =
    configuredUser() ||
    (await ctx.cli.inspectMachine(id).catch(() => undefined))?.username ||
    os.userInfo().username;
  return openOverSsh(
    ctx,
    machineTarget(ctx.cli, id),
    user,
    {},
    async result => {
      const state = ctx.extension.globalState;
      await state.update(MACHINE_HOSTS_KEY, {
        ...state.get<Record<string, SshHost>>(MACHINE_HOSTS_KEY, {}),
        [id]: {id, sshd: result.sshd, user: result.user},
      });
      await writeSshConfig(ctx);
    },
  );
}

/**
 * Opens one container of a pod of a `container cluster` with Remote-SSH, the same way as a container: sshd runs on
 * the connection through `kubectl exec`. The pod's container must run as root, since kubectl cannot switch users.
 */
export async function openPodOverSsh(
  ctx: CommandContext,
  ref: PodRef & {version?: string; multiContainer?: boolean},
): Promise<boolean> {
  // Before kubectl, which may have to be downloaded first
  if (!(await ensureRemoteSshExtension())) {
    return false;
  }
  const {kubectl, target: kube} = await ctx.k8s.prepare(ref.cluster, {
    interactive: true,
    version: ref.version,
  });
  // A pod opened before keeps its host, so its Remote-SSH window and recent entry still match
  const saved = Object.values(
    ctx.extension.globalState.get<Record<string, PodHost>>(POD_HOSTS_KEY, {}),
  );
  const alias =
    saved.find(host => samePod(host, ref))?.alias ??
    podHostAlias(ref, {
      multiContainer: ref.multiContainer,
      taken: candidate =>
        saved.some(host => host.alias === candidate && !samePod(host, ref)),
    });
  const target = podTarget(kubectl, kube, ref, alias);
  const cliPath = await ctx.cli.executable();
  return openOverSsh(
    ctx,
    target,
    configuredUser() || 'root',
    {},
    async result => {
      const state = ctx.extension.globalState;
      const host: PodHost = {
        alias: target.alias,
        hostName: `${ref.pod}.${ref.namespace}`,
        user: result.user,
        // The kubeconfig is written again on each connection, so a cluster recreated under the same name (new
        // certificates) still connects without browsing it first
        proxyCommand: withPrelude(
          cliPath,
          writeConfigArgs(ref.cluster, kube.kubeconfig),
          proxyCommand(
            kubectl,
            (argv, options) => target.exec(argv, options),
            result.sshd,
            POD_SSHD_ARGS,
          ),
        ),
        cluster: ref.cluster,
        namespace: ref.namespace,
        pod: ref.pod,
        container: ref.container,
        time: Date.now(),
      };
      await state.update(POD_HOSTS_KEY, {
        ...state.get<Record<string, PodHost>>(POD_HOSTS_KEY, {}),
        [host.alias]: host,
      });
      await writeSshConfig(ctx);
    },
  );
}

/**
 * Rewrites the managed SSH config: the running containers (prepared ones with their sshd and user, others with
 * defaults so they connect once set up), the machines opened before that still exist and the most recently opened
 * pods of clusters that still exist.
 */
async function writeSshConfig(ctx: CommandContext): Promise<void> {
  const {cli} = ctx;
  const state = ctx.extension.globalState;

  const saved = {...state.get<Record<string, SshHost>>(HOSTS_KEY, {})};
  const containers = (await cli.listContainers()).filter(c => !c.builder);
  const known = new Set(containers.map(c => c.id));
  for (const key of Object.keys(saved)) {
    if (!known.has(key)) {
      delete saved[key];
    }
  }
  await state.update(HOSTS_KEY, saved);
  const hosts = containers.map(
    c =>
      saved[c.id] ?? {
        id: c.id,
        sshd: DEFAULT_SSHD,
        user: c.user?.split(':')[0] || 'root',
      },
  );

  // Pods of deleted clusters go; when the clusters cannot be listed right now, every pod host is kept
  const clusters = await cli
    .listClusters()
    .then(list => new Set(list.map(c => c.name)))
    .catch(() => undefined);
  const pods = Object.values(
    state.get<Record<string, PodHost>>(POD_HOSTS_KEY, {}),
  )
    .filter(pod => !clusters || clusters.has(pod.cluster))
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_POD_HOSTS);
  await state.update(
    POD_HOSTS_KEY,
    Object.fromEntries(pods.map(pod => [pod.alias, pod])),
  );

  // Machines opened before, while they exist; when they cannot be listed right now, every machine host is kept
  const cliPath = await cli.executable();
  const machineIds = await cli
    .listMachines()
    .then(list => new Set(list.map(m => m.id)))
    .catch(() => undefined);
  const machines = Object.values(
    state.get<Record<string, SshHost>>(MACHINE_HOSTS_KEY, {}),
  ).filter(host => !machineIds || machineIds.has(host.id));
  await state.update(
    MACHINE_HOSTS_KEY,
    Object.fromEntries(machines.map(host => [host.id, host])),
  );

  await writeConfig(
    renderConfig(hosts, cliPath, undefined, [
      ...machines.map(host => ({
        alias: machineHostAlias(host.id),
        hostName: host.id,
        user: host.user,
        proxyCommand: proxyCommand(
          cliPath,
          (argv, options) => machineRunArgs(host.id, argv, options),
          host.sshd,
        ),
      })),
      ...pods.map(({alias, hostName, user, proxyCommand}) => ({
        alias,
        hostName,
        user,
        proxyCommand,
      })),
    ]),
  );
}

/**
 * Prepares `target` for SSH (sshd installed if needed, key authorized), lets `saveHost` write its host entry, and
 * opens a folder in it with Remote-SSH. Resolves false when it stopped early.
 */
async function openOverSsh(
  ctx: CommandContext,
  target: ExecTarget,
  user: string,
  options: SshOpenOptions,
  saveHost: (result: PrepareResult) => Promise<void>,
): Promise<boolean> {
  const state = ctx.extension.globalState;
  const name = target.name;
  if (!(await ensureRemoteSshExtension())) {
    return false;
  }
  // Package installs show the package manager's output as steps in a terminal: the caller's, or one opened on first use
  let ownTerminal: StepTerminal | undefined;
  const install: InstallRunner = async ({
    executable,
    args,
    packages,
    cancelArgs,
  }) => {
    const terminal =
      options.terminal ??
      (ownTerminal ??= await StepTerminal.start(
        vscode.l10n.t('Prepare {0} for Remote-SSH', name),
      ));
    return terminal.run(
      vscode.l10n.t('Install {0}', packages.join(' ')),
      executable,
      args,
      {onCancel: () => target.run(cancelArgs, {timeoutMs: 15_000})},
    );
  };

  const prepare = () =>
    withProgress(
      vscode.l10n.t('Preparing SSH access to {0}...', name),
      async () => {
        const publicKey = await ensureClientKey();
        const result = await prepareTarget(target, user, publicKey);
        await saveHost(result);
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
          await installSshd(target, install);
        } catch (installError) {
          // Stopped by the user in the terminal: no error to report
          if (installError instanceof vscode.CancellationError) {
            throw installError;
          }
          await reportMissingSshd(target, installError);
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
            name,
          ),
        );
        return undefined;
      }
      if (error instanceof PodNotRootError) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Pod {0} runs as uid {1}. Opening a pod over Remote-SSH sets up sshd as root, and kubectl exec cannot switch to root; use a container that runs as root.',
            name,
            error.uid,
          ),
        );
        return undefined;
      }
      throw error;
    }

    const packages = missingPackages(result);
    if (packages.length) {
      try {
        await installPackages(target, packages, install);
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
              name,
              reason,
            ),
          );
          return undefined;
        }
        // The first connection still works: Remote-SSH downloads the server on this Mac and copies it in
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Could not install wget in container {0}: {1}. Remote-SSH cannot reconnect while its server is running there; install wget or curl in the container.',
            name,
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

  await writeSessionEnvironment(target, prepared.user, options.remoteEnv);
  await ensureIncluded();

  // Remembered per login, since another user starts in another home; containers by id, pods by host alias
  const folderKey = `${prepared.user}@${target.switchesUser ? name : target.alias}`;
  const folders = state.get<Record<string, string>>(FOLDERS_KEY, {});
  const folder =
    options.folder ??
    (await pickTargetPath(target, {
      title: vscode.l10n.t('Open {0} over Remote-SSH', name),
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
    authority: `ssh-remote+${target.alias}`,
    path: folder,
  });
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    uri,
    options.reuseWindow ? {forceReuseWindow: true} : {forceNewWindow: true},
  );
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
async function reportMissingSshd(
  target: ExecTarget,
  cause: unknown,
): Promise<void> {
  const copy = vscode.l10n.t('Copy Install Command');
  // Only containers and machines have a shell command; pods leave it to kubectl
  const shell = target.switchesUser ? vscode.l10n.t('Attach Shell') : undefined;
  const reason = installFailure(cause);
  const answer = await vscode.window.showErrorMessage(
    vscode.l10n.t(
      'Could not install openssh-server in container {0}.',
      target.name,
    ),
    {
      modal: true,
      detail: vscode.l10n.t(
        '{0}\n\nInstall it inside the container yourself, for example:\n{1}',
        reason,
        INSTALL_HINT,
      ),
    },
    copy,
    ...(shell ? [shell] : []),
  );
  if (answer === copy) {
    await vscode.env.clipboard.writeText(INSTALL_HINT);
  } else if (shell && answer === shell) {
    // A machine's root shell, since installing packages needs root there
    await vscode.commands.executeCommand(
      target.machine
        ? 'appleContainer.machine.rootShell'
        : 'appleContainer.container.exec',
      {resource: {id: target.name}},
    );
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
