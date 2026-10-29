// Opens a folder in a dev container described by devcontainer.json: the bundled devcontainers/cli creates it
// with Apple container (through the docker shim) and the folder is entered over Remote-SSH

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as path from 'path';

import * as vscode from 'vscode';

import type { ContainerSummary } from '../models/types';
import { findConfigFiles, hash, LABEL_CONFIG_FILE, LABEL_LOCAL_FOLDER, localFolderOf, parseConfig } from '../services/devcontainer';
import {
  cliEnv,
  type DevContainerCliPaths,
  type DevContainerTarget,
  prepareDockerWrapper,
  readConfiguration,
  runDefaults,
  upArgs,
} from '../services/devcontainerCli';
import { parseEnvOutput, resolveContainerEnv } from '../utils/env';
import { runTask } from '../ui/terminal';
import { CommandContext, isLocal, register } from './common';
import { openContainerOverSsh } from './remoteSsh';

/** workspaceState key */
const PROMPT_DISMISSED_KEY = 'devcontainer.promptDismissed';
/** globalState key: configuration hash per container id, recorded when the container was created or opened */
const CONFIG_HASHES_KEY = 'devcontainer.configHashes';

export interface DevContainerOptions {
  /** Delete the existing container (and rebuild its image) first */
  rebuild?: boolean;
}

export function registerDevContainerCommands(ctx: CommandContext): void {
  register(ctx, 'appleContainer.devcontainer.open', async (uri?: vscode.Uri, options?: DevContainerOptions) => {
    const configFile = await resolveConfigFile(uri);
    if (configFile) {
      await openDevContainer(ctx, configFile, options ?? {});
    }
  });

  register(ctx, 'appleContainer.devcontainer.rebuild', async (uri?: vscode.Uri) => {
    const configFile = await resolveConfigFile(uri);
    if (configFile) {
      await openDevContainer(ctx, configFile, { rebuild: true });
    }
  });

  void offerToOpen(ctx);
}

/** Once per workspace: offer to open a local folder that has a devcontainer.json */
async function offerToOpen(ctx: CommandContext): Promise<void> {
  const state = ctx.extension.workspaceState;
  if (state.get<boolean>(PROMPT_DISMISSED_KEY)) {
    return;
  }
  // In a remote window (e.g. already inside the dev container) the folder is not on this Mac
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  if (!folders.some((f) => findConfigFiles(f.uri.fsPath).length)) {
    return;
  }
  const open = vscode.l10n.t('Open in Dev Container');
  const never = vscode.l10n.t("Don't Show Again");
  const answer = await vscode.window.showInformationMessage(
    vscode.l10n.t('This folder has a dev container configuration. Open it in a container with Apple container?'),
    open,
    never,
  );
  if (answer === open) {
    await vscode.commands.executeCommand('appleContainer.devcontainer.open');
  } else if (answer === never) {
    await state.update(PROMPT_DISMISSED_KEY, true);
  }
}

/** The clicked devcontainer.json, or one found in the workspace folders (asking when there are several) */
async function resolveConfigFile(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri instanceof vscode.Uri) {
    return isLocal(uri) ? uri.fsPath : undefined;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const files = folders.flatMap((f) => findConfigFiles(f.uri.fsPath));
  if (!files.length) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('No devcontainer.json was found. Add .devcontainer/devcontainer.json to a local workspace folder.'),
    );
    return undefined;
  }
  if (files.length === 1) {
    return files[0];
  }
  const picked = await vscode.window.showQuickPick(
    files.map((file) => ({ label: vscode.workspace.asRelativePath(file), description: localFolderOf(file), file })),
    { title: vscode.l10n.t('Select a dev container configuration') },
  );
  return picked?.file;
}

/** Hash of the configuration and its Dockerfile, to notice changes since the container was created */
async function configurationHash(configFile: string, configText: string, config: Record<string, any>): Promise<string> {
  const dockerfile: string | undefined = config.build?.dockerfile ?? config.dockerFile;
  const dockerfilePath = dockerfile ? path.resolve(path.dirname(configFile), dockerfile) : undefined;
  const dockerfileText = dockerfilePath && existsSync(dockerfilePath) ? await readFile(dockerfilePath, 'utf8') : '';
  return hash(configText, dockerfileText);
}

/** The container devcontainers/cli created for this configuration, found by the labels it sets */
async function findDevContainer(ctx: CommandContext, target: DevContainerTarget): Promise<ContainerSummary | undefined> {
  return (await ctx.cli.listContainers()).find(
    (c) => c.labels[LABEL_LOCAL_FOLDER] === target.workspaceFolder && c.labels[LABEL_CONFIG_FILE] === target.configFile,
  );
}

async function cliPaths(ctx: CommandContext): Promise<DevContainerCliPaths> {
  const dist = vscode.Uri.joinPath(ctx.extension.extensionUri, 'dist').fsPath;
  const node = process.execPath;
  return {
    node,
    script: path.join(dist, 'devcontainer-cli', 'run.js'),
    dockerPath: await prepareDockerWrapper(ctx.extension.globalStorageUri.fsPath, node, path.join(dist, 'docker-shim.js')),
    containerCli: await ctx.cli.executable(),
  };
}

/**
 * Creates or reuses the container for the configuration with devcontainers/cli, which also installs features and
 * runs the lifecycle commands, then opens the workspace folder over Remote-SSH. Resolves false when it stopped early.
 */
export async function openDevContainer(ctx: CommandContext, configFile: string, options: DevContainerOptions): Promise<boolean> {
  const configText = await readFile(configFile, 'utf8');
  const config = parseConfig(configText, configFile);
  if (config.dockerComposeFile) {
    throw new Error(vscode.l10n.t('Docker Compose dev containers (dockerComposeFile) are not supported by Apple container.'));
  }
  const target: DevContainerTarget = { workspaceFolder: localFolderOf(configFile), configFile };
  const name: string = config.name ?? path.basename(target.workspaceFolder);
  const configHash = await configurationHash(configFile, configText, config);
  const hashes = ctx.extension.globalState.get<Record<string, string>>(CONFIG_HASHES_KEY, {});

  const existing = await findDevContainer(ctx, target);
  let rebuild = options.rebuild ?? false;
  if (existing && !rebuild && hashes[existing.id] !== undefined && hashes[existing.id] !== configHash) {
    const rebuildNow = vscode.l10n.t('Rebuild');
    const keep = vscode.l10n.t('Use Existing Container');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('The dev container configuration of {0} changed since the container was created.', name),
      { modal: true, detail: vscode.l10n.t('Rebuilding deletes the container {0} and creates it again. Files outside the workspace folder and mounts are lost.', existing.id) },
      rebuildNow,
      keep,
    );
    if (answer === undefined) {
      return false;
    }
    rebuild = answer === rebuildNow;
  }

  const paths = await cliPaths(ctx);
  const defaultMemory = vscode.workspace.getConfiguration('appleContainer').get<string>('devcontainer.memory', '4G');
  // The task terminal shows the CLI log: image builds, features, lifecycle commands and shim warnings
  const code = await runTask(
    vscode.l10n.t('Dev Container: {0}', name),
    paths.node,
    upArgs(paths, target, { removeExisting: rebuild && !!existing }),
    target.workspaceFolder,
    cliEnv(paths, runDefaults(config.hostRequirements, defaultMemory)),
  );
  await ctx.refreshAll();
  if (code !== 0) {
    throw new Error(vscode.l10n.t('Starting the dev container failed (exit {0}). See the task output.', String(code)));
  }
  const container = await findDevContainer(ctx, target);
  if (!container) {
    throw new Error(vscode.l10n.t('The dev container for {0} was not found after it started.', name));
  }
  await ctx.extension.globalState.update(CONFIG_HASHES_KEY, { ...hashes, [container.id]: configHash });

  const resolved = await readConfiguration(paths, target);
  // remoteEnv may refer to the container's variables and can change without a rebuild, so it is resolved on every open
  const remoteEnv = resolveContainerEnv(resolved.remoteEnv, parseEnvOutput(await ctx.cli.run(['exec', container.id, 'env'])));
  return openContainerOverSsh(
    ctx,
    { id: container.id, user: container.user },
    { user: resolved.remoteUser ?? resolved.containerUser, folder: resolved.workspaceFolder, remoteEnv },
  );
}
