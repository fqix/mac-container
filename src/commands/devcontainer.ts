// Opens a folder in a dev container described by devcontainer.json, run with Apple container and entered over Remote-SSH

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  type CommandStep,
  type DevContainerPlan,
  execArgs,
  findConfigFiles,
  LABEL_CONFIG_HASH,
  type LifecycleName,
  localFolderOf,
  parseConfig,
  planDevContainer,
} from '../services/devcontainer';
import { parseEnvOutput, resolveContainerEnv } from '../utils/env';
import { runTask } from '../ui/terminal';
import { CommandContext, isLocal, register, withProgress } from './common';
import { openContainerOverSsh } from './remoteSsh';

/** workspaceState keys */
const PROMPT_DISMISSED_KEY = 'devcontainer.promptDismissed';
const ACKNOWLEDGED_KEY = 'devcontainer.acknowledgedUnsupported';

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

async function loadPlan(configFile: string): Promise<DevContainerPlan> {
  const configText = await readFile(configFile, 'utf8');
  const config = parseConfig(configText, configFile);
  const dockerfile: string | undefined = config.build?.dockerfile ?? config.dockerFile;
  const dockerfilePath = dockerfile ? path.resolve(path.dirname(configFile), dockerfile) : undefined;
  return planDevContainer({
    config,
    configFile,
    configText,
    localWorkspaceFolder: localFolderOf(configFile),
    localEnv: process.env,
    dockerfileText: dockerfilePath && existsSync(dockerfilePath) ? await readFile(dockerfilePath, 'utf8') : undefined,
  });
}

/**
 * Creates or reuses the container for the configuration, runs the lifecycle commands the spec asks for
 * and opens the workspace folder over Remote-SSH. Resolves false when it stopped early.
 */
export async function openDevContainer(ctx: CommandContext, configFile: string, options: DevContainerOptions): Promise<boolean> {
  const { cli } = ctx;
  const plan = await loadPlan(configFile);

  if (plan.unsupported.length && !(await acknowledgeUnsupported(ctx, plan))) {
    return false;
  }

  let existing = (await cli.listContainers()).find((c) => c.id === plan.containerName);
  let rebuild = options.rebuild ?? false;
  if (existing && !rebuild && existing.labels[LABEL_CONFIG_HASH] !== plan.configHash) {
    const rebuildNow = vscode.l10n.t('Rebuild');
    const keep = vscode.l10n.t('Use Existing Container');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('The dev container configuration of {0} changed since the container was created.', plan.name),
      { modal: true, detail: vscode.l10n.t('Rebuilding deletes the container {0} and creates it again. Files outside the workspace folder and mounts are lost.', plan.containerName) },
      rebuildNow,
      keep,
    );
    if (answer === undefined) {
      return false;
    }
    rebuild = answer === rebuildNow;
  }
  if (existing && rebuild) {
    await withProgress(vscode.l10n.t('Removing {0}...', plan.containerName), () =>
      cli.run(['delete', '--force', plan.containerName], { timeoutMs: 120_000 }),
    );
    existing = undefined;
  }

  // initializeCommand runs on this Mac on every open, before anything else
  await runSteps(plan, 'initializeCommand', (step) => ({ executable: step.argv[0], args: step.argv.slice(1), cwd: localFolderOf(configFile) }));

  const created = !existing;
  const started = created || existing!.state !== 'running';
  if (created) {
    if (plan.build) {
      const code = await runTask(vscode.l10n.t('Build {0}', plan.image), await cli.executable(), plan.build.args, plan.build.context);
      if (code !== 0) {
        throw new Error(vscode.l10n.t('Building the dev container image failed (exit {0}). See the task output.', String(code)));
      }
    }
    await withProgress(vscode.l10n.t('Starting dev container {0}...', plan.name), () => cli.run(plan.runArgs, { timeoutMs: 10 * 60_000 }));
  } else if (started) {
    await withProgress(vscode.l10n.t('Starting dev container {0}...', plan.name), () => cli.run(['start', plan.containerName], { timeoutMs: 120_000 }));
  }
  await ctx.refreshAll();

  // remoteEnv may refer to the container's variables and can change without a rebuild, so it is resolved on every open
  const remoteEnv = resolveContainerEnv(plan.remoteEnv, parseEnvOutput(await cli.run(['exec', plan.containerName, 'env'])));
  const cliPath = await cli.executable();
  const inContainer = (step: CommandStep) => ({ executable: cliPath, args: execArgs(plan, step, remoteEnv) });
  if (created) {
    for (const hook of ['onCreateCommand', 'updateContentCommand', 'postCreateCommand'] as const) {
      await runSteps(plan, hook, inContainer);
    }
  }
  if (started) {
    await runSteps(plan, 'postStartCommand', inContainer);
  }
  await runSteps(plan, 'postAttachCommand', inContainer);

  const container = (await cli.listContainers()).find((c) => c.id === plan.containerName);
  return openContainerOverSsh(ctx, { id: plan.containerName, user: container?.user }, { user: plan.remoteUser, folder: plan.workspaceFolder, remoteEnv });
}

/** Shows the properties that will be ignored once per configuration version */
async function acknowledgeUnsupported(ctx: CommandContext, plan: DevContainerPlan): Promise<boolean> {
  const state = ctx.extension.workspaceState;
  const acknowledged = state.get<Record<string, string>>(ACKNOWLEDGED_KEY, {});
  if (acknowledged[plan.containerName] === plan.configHash) {
    return true;
  }
  const proceed = vscode.l10n.t('Continue');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t('Some dev container settings are not supported by Apple container and will be ignored.'),
    { modal: true, detail: plan.unsupported.join('\n') },
    proceed,
  );
  if (answer !== proceed) {
    return false;
  }
  await state.update(ACKNOWLEDGED_KEY, { ...acknowledged, [plan.containerName]: plan.configHash });
  return true;
}

/** Runs a lifecycle command as tasks so its output is visible; entries of the object form run in parallel */
async function runSteps(
  plan: DevContainerPlan,
  hook: LifecycleName,
  toProcess: (step: CommandStep) => { executable: string; args: string[]; cwd?: string },
): Promise<void> {
  const steps = plan.lifecycle[hook];
  if (!steps?.length) {
    return;
  }
  const codes = await Promise.all(
    steps.map((step) => {
      const { executable, args, cwd } = toProcess(step);
      return runTask(step.label ? `${hook}: ${step.label}` : hook, executable, args, cwd);
    }),
  );
  const failed = codes.find((code) => code !== 0);
  if (failed !== undefined) {
    // The spec skips the remaining commands when one fails
    throw new Error(vscode.l10n.t('{0} of the dev container failed (exit {1}). See the task output.', hook, String(failed)));
  }
}
