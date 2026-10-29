// Webview form for running a container from an image, or editing an existing container.
// Editing is applied by recreating the container, since Apple container cannot change these settings in place.

import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';
import {
  buildRunArgs,
  type ContainerSettings,
  EMPTY_SETTINGS,
  type FormFromWebview,
  type FormToWebview,
  mergeEnv,
  parseDotEnv,
  type SettingsProblem,
  settingsFromConfig,
  validateSettings,
} from '../services/containerSettings';
import { buildRecreateArgs } from '../services/recreate';
import { describeError } from '../utils/i18n';
import { generateContainerName } from '../utils/names';
import { parseContainers, parseJson, shortImageName } from '../utils/parse';
import { webviewHtml, webviewRoot } from './webviewHtml';

type Json = Record<string, any>;

type Target = { mode: 'edit'; containerId: string } | { mode: 'run'; image: string };

export class ContainerFormPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, ContainerFormPanel>();

  static showEdit(extensionUri: vscode.Uri, cli: ContainerCli, containerId: string, onChanged: () => Promise<void>): void {
    ContainerFormPanel.show(extensionUri, cli, { mode: 'edit', containerId }, onChanged);
  }

  static showRun(extensionUri: vscode.Uri, cli: ContainerCli, image: string, onChanged: () => Promise<void>): void {
    ContainerFormPanel.show(extensionUri, cli, { mode: 'run', image }, onChanged);
  }

  private static show(extensionUri: vscode.Uri, cli: ContainerCli, target: Target, onChanged: () => Promise<void>): void {
    const key = target.mode === 'edit' ? `edit:${target.containerId}` : `run:${target.image}`;
    const existing = ContainerFormPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    ContainerFormPanel.panels.set(key, new ContainerFormPanel(extensionUri, cli, target, key, onChanged));
  }

  static disposeAll(): void {
    for (const panel of [...ContainerFormPanel.panels.values()]) {
      panel.dispose();
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  /** Name suggested when running, used when the name field is left empty */
  private suggestedName = '';

  private constructor(
    extensionUri: vscode.Uri,
    private readonly cli: ContainerCli,
    private readonly target: Target,
    private readonly key: string,
    private readonly onChanged: () => Promise<void>,
  ) {
    const title =
      target.mode === 'edit' ? vscode.l10n.t('Edit: {0}', target.containerId) : vscode.l10n.t('Run: {0}', shortImageName(target.image));
    this.panel = vscode.window.createWebviewPanel(
      target.mode === 'edit' ? 'appleContainer.edit' : 'appleContainer.run',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [webviewRoot(extensionUri)], retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'container.svg');
    this.panel.webview.html = this.html(extensionUri, title);
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((message: FormFromWebview) => void this.handle(message));
  }

  private async handle(message: FormFromWebview): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInit();
          break;
        case 'browse': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: false,
            title: vscode.l10n.t('Select a host path to mount'),
          });
          if (picked?.[0]) {
            this.post({ type: 'browsed', index: message.index, path: picked[0].fsPath });
          }
          break;
        }
        case 'importEnv': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            title: vscode.l10n.t('Import environment variables from .env files'),
            openLabel: vscode.l10n.t('Import'),
          });
          if (picked?.length) {
            let env = message.env;
            for (const uri of picked) {
              env = mergeEnv(env, parseDotEnv(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))));
            }
            this.post({ type: 'envImported', env });
          }
          break;
        }
        case 'save':
          if (this.target.mode === 'edit') {
            await this.saveEdit(this.target.containerId, message.settings);
          } else {
            await this.run(this.target.image, message.name, message.command, message.settings);
          }
          break;
        case 'cancel':
          this.dispose();
          break;
      }
    } catch (error) {
      this.post({ type: 'problems', messages: [describeError(error)] });
    }
  }

  private async inspect(containerId: string): Promise<Json> {
    const [item] = parseJson(await this.cli.inspect('container', [containerId])) as Json[];
    if (!item?.configuration) {
      throw new Error(vscode.l10n.t('Container {0} no longer exists.', containerId));
    }
    return item;
  }

  private async sendInit(): Promise<void> {
    const [volumes, networks] = await Promise.all([this.cli.listVolumes(), this.cli.listNetworks()]);
    const common = { volumes: volumes.map((v) => v.name), networks: networks.map((n) => n.id) };
    if (this.target.mode === 'edit') {
      const item = await this.inspect(this.target.containerId);
      const [summary] = parseContainers([item]);
      this.post({
        type: 'init',
        mode: 'edit',
        name: summary.id,
        image: summary.image,
        running: summary.state === 'running',
        // tmpfs and bind/volume mounts are editable; anything else is kept as it is by the form
        settings: settingsFromConfig(item.configuration, summary.publishedPorts, summary.mounts),
        ...common,
      });
    } else {
      this.suggestedName = generateContainerName(new Set((await this.cli.listContainers()).map((c) => c.id)));
      this.post({ type: 'init', mode: 'run', name: this.suggestedName, image: this.target.image, running: false, settings: EMPTY_SETTINGS, ...common });
    }
  }

  private async run(image: string, name: string, command: string, settings: ContainerSettings): Promise<void> {
    const problems = validateSettings(settings, name);
    if (problems.length) {
      this.post({ type: 'problems', messages: problems.map(problemMessage) });
      return;
    }
    const finalName = name || this.suggestedName;
    this.post({ type: 'busy', busy: true });
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Starting container from {0}...', image) },
        () => this.cli.run(buildRunArgs({ image, name: finalName, command, settings }), { timeoutMs: 10 * 60_000 }),
      );
      void vscode.window.showInformationMessage(vscode.l10n.t('Container {0} started.', finalName));
      await this.onChanged();
      this.dispose();
    } catch (error) {
      await this.onChanged();
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'problems', messages: [describeError(error)] });
    }
  }

  private async saveEdit(containerId: string, settings: ContainerSettings): Promise<void> {
    const problems = validateSettings(settings);
    if (problems.length) {
      this.post({ type: 'problems', messages: problems.map(problemMessage) });
      return;
    }
    const item = await this.inspect(containerId);

    const recreate = vscode.l10n.t('Recreate');
    const keep = vscode.l10n.t('Keep Changes and Recreate');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Recreate container {0} with the new settings?', containerId),
      {
        modal: true,
        detail: vscode.l10n.t(
          'The container is deleted and created again from its image. Files changed inside the container (outside volumes and mounts) are lost unless you keep the changes, which first commits the container to a snapshot image.',
        ),
      },
      recreate,
      keep,
    );
    if (answer !== recreate && answer !== keep) {
      return;
    }

    this.post({ type: 'busy', busy: true });
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Recreating {0}...', containerId) },
        (progress) => recreateContainer(this.cli, item, settings, answer === keep, (message) => progress.report({ message })),
      );
      void vscode.window.showInformationMessage(vscode.l10n.t('Container {0} was recreated.', containerId));
      await this.onChanged();
      this.dispose();
    } catch (error) {
      await this.onChanged();
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'problems', messages: [describeError(error)] });
    }
  }

  private post(message: FormToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private html(extensionUri: vscode.Uri, title: string): string {
    const labels = {
      editTitle: vscode.l10n.t('Edit Container'),
      runTitle: vscode.l10n.t('Run Container'),
      image: vscode.l10n.t('Image'),
      name: vscode.l10n.t('Name'),
      namePlaceholder: vscode.l10n.t('random name'),
      command: vscode.l10n.t('Command or shell script'),
      commandPlaceholder: vscode.l10n.t('Empty runs the image default command'),
      commandHint: vscode.l10n.t('Run with /bin/sh -c, e.g. apk add curl && exec sleep infinity'),
      ports: vscode.l10n.t('Port Forwarding'),
      mounts: vscode.l10n.t('Mounts'),
      env: vscode.l10n.t('Environment Variables'),
      envHint: vscode.l10n.t('One KEY=VALUE per line. A bare KEY takes the value from this Mac.'),
      importEnv: vscode.l10n.t('Import .env...'),
      networks: vscode.l10n.t('Networks'),
      networksHint: vscode.l10n.t('None selected attaches the default network.'),
      resources: vscode.l10n.t('Resources'),
      cpus: vscode.l10n.t('CPUs'),
      memory: vscode.l10n.t('Memory'),
      memoryPlaceholder: vscode.l10n.t('e.g. 512M or 2G'),
      defaultValue: vscode.l10n.t('default'),
      process: vscode.l10n.t('Process'),
      user: vscode.l10n.t('User'),
      userPlaceholder: vscode.l10n.t('name, uid or uid:gid'),
      workdir: vscode.l10n.t('Working directory'),
      hostAddress: vscode.l10n.t('Host address'),
      hostPort: vscode.l10n.t('Host port'),
      containerPort: vscode.l10n.t('Container port'),
      protocol: vscode.l10n.t('Protocol'),
      type: vscode.l10n.t('Type'),
      source: vscode.l10n.t('Source'),
      destination: vscode.l10n.t('Container path'),
      readOnly: vscode.l10n.t('Read-only'),
      volume: vscode.l10n.t('Named volume'),
      bind: vscode.l10n.t('Bind mount'),
      tmpfs: 'tmpfs',
      addPort: vscode.l10n.t('Add Port'),
      addMount: vscode.l10n.t('Add Mount'),
      remove: vscode.l10n.t('Remove'),
      browse: vscode.l10n.t('Browse...'),
      save: vscode.l10n.t('Save and Recreate'),
      run: vscode.l10n.t('Run'),
      cancel: vscode.l10n.t('Cancel'),
      noPorts: vscode.l10n.t('No published ports.'),
      noMounts: vscode.l10n.t('No mounts.'),
      running: vscode.l10n.t('Running'),
      stopped: vscode.l10n.t('Stopped'),
      hint: vscode.l10n.t('Saving deletes the container and creates it again with the same image and command, using the settings below.'),
      volumePlaceholder: vscode.l10n.t('volume name'),
      bindPlaceholder: vscode.l10n.t('/absolute/host/path'),
    };
    return webviewHtml(this.panel.webview, extensionUri, 'containerForm', title, { labels: JSON.stringify(labels) });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ContainerFormPanel.panels.delete(this.key);
    this.panel.dispose();
  }
}

/**
 * Deletes the container and creates it again with the edited settings.
 * If the new container cannot be created, the original one is restored.
 * Returns the snapshot image reference when keepChanges is set.
 */
export async function recreateContainer(
  cli: ContainerCli,
  item: Json,
  settings: ContainerSettings,
  keepChanges: boolean,
  report: (message: string) => void = () => undefined,
): Promise<string | undefined> {
  const [original] = parseContainers([item]);
  const config = item.configuration as Json;
  const running = original.state === 'running';
  let image: string | undefined;
  if (keepChanges) {
    image = snapshotReference(original.id);
    report(vscode.l10n.t('Committing snapshot {0}', image));
    await cli.run(['commit', original.id, image], { timeoutMs: 10 * 60_000 });
  }
  const restoreArgs = buildRecreateArgs(config, settingsFromConfig(config, original.publishedPorts, original.mounts), { start: running });
  const nextArgs = buildRecreateArgs(config, settings, { start: running, image });

  report(vscode.l10n.t('Removing the old container'));
  await cli.run(['delete', '--force', original.id], { timeoutMs: 120_000 });
  report(vscode.l10n.t('Creating the new container'));
  try {
    await cli.run(nextArgs, { timeoutMs: 10 * 60_000 });
  } catch (error) {
    // Put the original container back so a bad edit never loses it
    await cli.run(['delete', '--force', original.id]).catch(() => undefined);
    try {
      await cli.run(restoreArgs, { timeoutMs: 10 * 60_000 });
    } catch (restoreError) {
      throw new Error(
        vscode.l10n.t(
          'Recreating failed: {0}. Restoring the original container also failed: {1}',
          describeError(error),
          describeError(restoreError),
        ),
      );
    }
    throw new Error(vscode.l10n.t('Recreating failed, the original container was restored: {0}', describeError(error)));
  }
  return image;
}

/** Lowercase image reference such as web-snapshot:20261028-163000 */
function snapshotReference(containerId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${containerId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}-snapshot:${stamp}`;
}

export function problemMessage(problem: SettingsProblem): string {
  const row = problem.index + 1;
  const where: Record<SettingsProblem['section'], string> = {
    ports: vscode.l10n.t('Port {0}', row),
    mounts: vscode.l10n.t('Mount {0}', row),
    env: vscode.l10n.t('Environment variable {0}', row),
    resources: vscode.l10n.t('Resources'),
    process: vscode.l10n.t('Process'),
    name: vscode.l10n.t('Name'),
  };
  const reasons: Record<SettingsProblem['reason'], string> = {
    portRange: vscode.l10n.t('ports must be between 1 and 65535'),
    protocol: vscode.l10n.t('protocol must be tcp or udp'),
    duplicateHostPort: vscode.l10n.t('the host port is used more than once'),
    relativeTarget: vscode.l10n.t('the container path must be absolute'),
    relativeSource: vscode.l10n.t('the host path must be absolute'),
    volumeName: vscode.l10n.t('invalid volume name'),
    duplicateTarget: vscode.l10n.t('the container path is mounted more than once'),
    envName: vscode.l10n.t('expected KEY=VALUE with a valid name'),
    cpus: vscode.l10n.t('CPUs must be a whole number of at least 1'),
    memory: vscode.l10n.t('memory must be a number with an optional K, M, G, T or P suffix'),
    workdir: vscode.l10n.t('the working directory must be absolute'),
    name: vscode.l10n.t('use letters, digits, _ . and -, starting with a letter or digit'),
  };
  return `${where[problem.section]}: ${reasons[problem.reason]}`;
}
