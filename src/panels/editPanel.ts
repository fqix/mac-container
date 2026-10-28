// Webview form for editing a container's published ports and mounts, applied by recreating the container

import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';
import { describeError } from '../utils/i18n';
import { parseContainers, parseJson } from '../utils/parse';
import {
  buildRecreateArgs,
  ContainerEdits,
  EditFromWebview,
  EditProblem,
  EditToWebview,
  validateEdits,
} from '../services/recreate';
import { webviewHtml, webviewRoot } from './webviewHtml';

type Json = Record<string, any>;

export class EditContainerPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, EditContainerPanel>();

  static show(extensionUri: vscode.Uri, cli: ContainerCli, containerId: string, onChanged: () => Promise<void>): void {
    const existing = EditContainerPanel.panels.get(containerId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    EditContainerPanel.panels.set(containerId, new EditContainerPanel(extensionUri, cli, containerId, onChanged));
  }

  static disposeAll(): void {
    for (const panel of [...EditContainerPanel.panels.values()]) {
      panel.dispose();
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly cli: ContainerCli,
    private readonly containerId: string,
    private readonly onChanged: () => Promise<void>,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'appleContainer.edit',
      vscode.l10n.t('Edit: {0}', containerId),
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [webviewRoot(extensionUri)], retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'container.svg');
    this.panel.webview.html = this.html(extensionUri);
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((message: EditFromWebview) => void this.handle(message));
  }

  private async handle(message: EditFromWebview): Promise<void> {
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
        case 'save':
          await this.save(message.edits);
          break;
        case 'cancel':
          this.dispose();
          break;
      }
    } catch (error) {
      this.post({ type: 'problems', messages: [describeError(error)] });
    }
  }

  private async inspect(): Promise<Json> {
    const [item] = parseJson(await this.cli.inspect('container', [this.containerId])) as Json[];
    if (!item?.configuration) {
      throw new Error(vscode.l10n.t('Container {0} no longer exists.', this.containerId));
    }
    return item;
  }

  private async sendInit(): Promise<void> {
    const [item, volumes] = await Promise.all([this.inspect(), this.cli.listVolumes()]);
    const [summary] = parseContainers([item]);
    this.post({
      type: 'init',
      id: summary.id,
      image: summary.image,
      running: summary.state === 'running',
      ports: summary.publishedPorts,
      // tmpfs and bind/volume mounts are editable; anything else is kept as it is by the form
      mounts: summary.mounts,
      volumes: volumes.map((v) => v.name),
    });
  }

  private async save(edits: ContainerEdits): Promise<void> {
    const problems = validateEdits(edits);
    if (problems.length) {
      this.post({ type: 'problems', messages: problems.map(problemMessage) });
      return;
    }
    const item = await this.inspect();

    const recreate = vscode.l10n.t('Recreate');
    const keep = vscode.l10n.t('Keep Changes and Recreate');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Recreate container {0} with the new ports and mounts?', this.containerId),
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
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Recreating {0}...', this.containerId) },
        (progress) => recreateContainer(this.cli, item, edits, answer === keep, (message) => progress.report({ message })),
      );
      void vscode.window.showInformationMessage(vscode.l10n.t('Container {0} was recreated.', this.containerId));
      await this.onChanged();
      this.dispose();
    } catch (error) {
      await this.onChanged();
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'problems', messages: [describeError(error)] });
    }
  }

  private post(message: EditToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private html(extensionUri: vscode.Uri): string {
    const labels = {
      title: vscode.l10n.t('Edit Container'),
      image: vscode.l10n.t('Image'),
      ports: vscode.l10n.t('Port Forwarding'),
      mounts: vscode.l10n.t('Mounts'),
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
      cancel: vscode.l10n.t('Cancel'),
      noPorts: vscode.l10n.t('No published ports.'),
      noMounts: vscode.l10n.t('No mounts.'),
      running: vscode.l10n.t('Running'),
      stopped: vscode.l10n.t('Stopped'),
      hint: vscode.l10n.t('Saving deletes the container and creates it again with the same image, command, environment and resources.'),
      volumePlaceholder: vscode.l10n.t('volume name'),
      bindPlaceholder: vscode.l10n.t('/absolute/host/path'),
    };
    return webviewHtml(this.panel.webview, extensionUri, 'edit', this.containerId, { labels: JSON.stringify(labels) });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    EditContainerPanel.panels.delete(this.containerId);
    this.panel.dispose();
  }
}

/**
 * Deletes the container and creates it again with the edited ports and mounts.
 * If the new container cannot be created, the original one is restored.
 * Returns the snapshot image reference when keepChanges is set.
 */
export async function recreateContainer(
  cli: ContainerCli,
  item: Json,
  edits: ContainerEdits,
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
  const restoreArgs = buildRecreateArgs(config, { ports: original.publishedPorts, mounts: original.mounts }, { start: running });
  const nextArgs = buildRecreateArgs(config, edits, { start: running, image });

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

function problemMessage(problem: EditProblem): string {
  const row = problem.index + 1;
  const where = problem.section === 'ports' ? vscode.l10n.t('Port {0}', row) : vscode.l10n.t('Mount {0}', row);
  const reasons: Record<EditProblem['reason'], string> = {
    portRange: vscode.l10n.t('ports must be between 1 and 65535'),
    protocol: vscode.l10n.t('protocol must be tcp or udp'),
    duplicateHostPort: vscode.l10n.t('the host port is used more than once'),
    relativeTarget: vscode.l10n.t('the container path must be absolute'),
    relativeSource: vscode.l10n.t('the host path must be absolute'),
    volumeName: vscode.l10n.t('invalid volume name'),
    duplicateTarget: vscode.l10n.t('the container path is mounted more than once'),
  };
  return `${where}: ${reasons[problem.reason]}`;
}
