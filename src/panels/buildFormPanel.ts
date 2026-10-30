// Webview form for building an image from a Dockerfile with build arguments, target stage, platforms and secrets.
// The build runs as a task; the options used last are remembered per Dockerfile.

import * as path from 'path';
import * as vscode from 'vscode';

import {
  BUILD_PLATFORMS,
  type BuildFromWebview,
  buildImageArgs,
  type BuildOptions,
  type BuildProblem,
  type BuildToWebview,
  defaultBuildOptions,
  parseStages,
  validateBuildOptions,
} from '../services/build';
import type { ContainerCli } from '../services/cli';
import { runCliTask } from '../ui/terminal';
import { describeError } from '../utils/i18n';
import { webviewHtml, webviewRoot } from './webviewHtml';

/** workspaceState key: options used last per Dockerfile path */
const OPTIONS_KEY = 'appleContainer.buildOptions';

export class BuildFormPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, BuildFormPanel>();

  /** @param onBuilt called with the tag after a successful build */
  static show(
    extension: vscode.ExtensionContext,
    cli: ContainerCli,
    dockerfile: vscode.Uri,
    onBuilt: (tag: string) => void,
  ): void {
    const existing = BuildFormPanel.panels.get(dockerfile.fsPath);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    BuildFormPanel.panels.set(dockerfile.fsPath, new BuildFormPanel(extension, cli, dockerfile, onBuilt));
  }

  static disposeAll(): void {
    for (const panel of [...BuildFormPanel.panels.values()]) {
      panel.dispose();
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    private readonly extension: vscode.ExtensionContext,
    private readonly cli: ContainerCli,
    private readonly dockerfile: vscode.Uri,
    private readonly onBuilt: (tag: string) => void,
  ) {
    const title = vscode.l10n.t('Build: {0}', path.basename(dockerfile.fsPath));
    this.panel = vscode.window.createWebviewPanel(
      'appleContainer.build',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [webviewRoot(extension.extensionUri)], retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extension.extensionUri, 'resources', 'container.svg');
    this.panel.webview.html = this.html(title);
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((message: BuildFromWebview) => void this.handle(message));
  }

  private async handle(message: BuildFromWebview): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInit();
          break;
        case 'pickContext': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: message.current ? vscode.Uri.file(message.current) : undefined,
            title: vscode.l10n.t('Select the build context folder'),
          });
          if (picked?.[0]) {
            this.post({ type: 'contextPicked', path: picked[0].fsPath });
          }
          break;
        }
        case 'build':
          await this.build(message.options);
          break;
        case 'cancel':
          this.dispose();
          break;
      }
    } catch (error) {
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'problems', messages: [describeError(error)] });
    }
  }

  private async sendInit(): Promise<void> {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.dockerfile));
    const defaults = defaultOptionsFor(this.dockerfile);
    const saved = this.extension.workspaceState.get<Record<string, BuildOptions>>(OPTIONS_KEY, {})[this.dockerfile.fsPath];
    this.post({
      type: 'init',
      file: vscode.workspace.asRelativePath(this.dockerfile, false),
      stages: parseStages(text),
      platforms: BUILD_PLATFORMS,
      // Saved options win, defaults fill fields added in later versions
      options: { ...defaults, ...saved },
    });
  }

  private async build(options: BuildOptions): Promise<void> {
    const problems = validateBuildOptions(options, process.env);
    if (!problems.length && !(await isDirectory(options.context))) {
      problems.push({ section: 'context', index: 0, reason: 'context' });
    }
    if (problems.length) {
      this.post({ type: 'problems', messages: problems.map(buildProblemMessage) });
      return;
    }
    const saved = this.extension.workspaceState.get<Record<string, BuildOptions>>(OPTIONS_KEY, {});
    await this.extension.workspaceState.update(OPTIONS_KEY, { ...saved, [this.dockerfile.fsPath]: options });

    this.post({ type: 'busy', busy: true });
    const code = await runCliTask(
      this.cli,
      vscode.l10n.t('Build {0}', options.tag),
      buildImageArgs(this.dockerfile.fsPath, options),
      options.context,
    );
    if (code === 0) {
      this.dispose();
      this.onBuilt(options.tag);
      return;
    }
    // Keep the form open so the options can be changed and the build retried
    this.post({ type: 'busy', busy: false });
    this.post({
      type: 'problems',
      messages: [
        code === undefined
          ? vscode.l10n.t('The build was stopped.')
          : vscode.l10n.t('The build failed with exit code {0}. See the terminal for the output.', code),
      ],
    });
  }

  private post(message: BuildToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private html(title: string): string {
    const labels = {
      buildTitle: vscode.l10n.t('Build Image'),
      tag: vscode.l10n.t('Image name and tag'),
      context: vscode.l10n.t('Build context'),
      browse: vscode.l10n.t('Browse...'),
      target: vscode.l10n.t('Target stage'),
      lastStage: vscode.l10n.t('last stage'),
      platforms: vscode.l10n.t('Platforms'),
      platformsHint: vscode.l10n.t('None selected builds for this Mac (linux/arm64). Several build a multi-platform image; linux/amd64 is built with Rosetta.'),
      buildArgs: vscode.l10n.t('Build Arguments'),
      buildArgsHint: vscode.l10n.t('One KEY=VALUE per line, read by ARG instructions. Values are stored in the image history; use secrets for credentials.'),
      secrets: vscode.l10n.t('Secrets'),
      secretsHint: vscode.l10n.t('One per line: id=KEY reads the environment variable KEY, id=KEY,env=VAR reads VAR, id=KEY,src=/path reads a file. Mount them with RUN --mount=type=secret,id=KEY.'),
      labels: vscode.l10n.t('Labels'),
      labelsHint: vscode.l10n.t('One KEY=VALUE per line.'),
      options: vscode.l10n.t('Options'),
      noCache: vscode.l10n.t('Do not use the build cache'),
      pull: vscode.l10n.t('Pull the base images again'),
      ssh: vscode.l10n.t('Forward the SSH agent (RUN --mount=type=ssh)'),
      build: vscode.l10n.t('Build'),
      building: vscode.l10n.t('Building... see the terminal for the output.'),
      cancel: vscode.l10n.t('Cancel'),
    };
    return webviewHtml(this.panel.webview, this.extension.extensionUri, 'buildForm', title, { labels: JSON.stringify(labels) });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    BuildFormPanel.panels.delete(this.dockerfile.fsPath);
    this.panel.dispose();
  }
}

/** The workspace folder (or the Dockerfile's folder) as context, tagged <folder name>:latest */
export function defaultOptionsFor(dockerfile: vscode.Uri): BuildOptions {
  const context = vscode.workspace.getWorkspaceFolder(dockerfile)?.uri.fsPath ?? path.dirname(dockerfile.fsPath);
  return defaultBuildOptions(`${path.basename(context).toLowerCase()}:latest`, context);
}

async function isDirectory(fsPath: string): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

export function buildProblemMessage(problem: BuildProblem): string {
  const row = problem.index + 1;
  const where: Record<BuildProblem['section'], string> = {
    tag: vscode.l10n.t('Image name and tag'),
    context: vscode.l10n.t('Build context'),
    target: vscode.l10n.t('Target stage'),
    buildArgs: vscode.l10n.t('Build argument {0}', row),
    secrets: vscode.l10n.t('Secret {0}', row),
    labels: vscode.l10n.t('Label {0}', row),
    ssh: vscode.l10n.t('SSH agent'),
  };
  const reasons: Record<BuildProblem['reason'], string> = {
    tag: vscode.l10n.t('enter an image name without spaces'),
    context: vscode.l10n.t('select an existing folder on this Mac'),
    target: vscode.l10n.t('the stage name cannot contain spaces'),
    keyValue: vscode.l10n.t('expected KEY=VALUE'),
    secretId: vscode.l10n.t('expected id=KEY at the start, without = in KEY'),
    secretValue: vscode.l10n.t('expected env=VAR or src=/path after the id'),
    secretEnv: vscode.l10n.t('the environment variable {0} is not set for VS Code', problem.name ?? ''),
    sshAgent: vscode.l10n.t('SSH_AUTH_SOCK is not set for VS Code, so there is no agent to forward'),
  };
  return `${where[problem.section]}: ${reasons[problem.reason]}`;
}
