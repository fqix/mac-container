// Add Dev Container Configuration...: picks one of the bundled Dev Container Templates (only what Apple container can
// run), asks for its options and Features, and writes it into the folder, without network access.

import {existsSync} from 'fs';
import {readFile} from 'fs/promises';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  applyTemplate,
  CODING_AGENTS,
  type CodingAgent,
  asDirectTemplate,
  type DirectTemplate,
  existingConfigs,
  type FeatureEntry,
  parseTemplateIndex,
  type TemplateEntry,
  type TemplateIndex,
  type TemplateOption,
  supportsCodingAgents,
} from '../services/devcontainerTemplates';
import {CommandContext, isLocal, register} from './common';

function templatesDir(ctx: CommandContext): string {
  return vscode.Uri.joinPath(
    ctx.extension.extensionUri,
    'resources',
    'devcontainer-templates',
  ).fsPath;
}

async function loadIndex(ctx: CommandContext): Promise<TemplateIndex> {
  return parseTemplateIndex(
    JSON.parse(
      await readFile(path.join(templatesDir(ctx), 'index.json'), 'utf8'),
    ),
  );
}

/** The explorer selection, else a workspace folder */
async function pickFolder(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri instanceof vscode.Uri) {
    return isLocal(uri) ? uri.fsPath : undefined;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    f => f.uri.scheme === 'file',
  );
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  if (folders.length > 1) {
    return (
      await vscode.window.showWorkspaceFolderPick({
        placeHolder: vscode.l10n.t('Folder to add the dev container to'),
      })
    )?.uri.fsPath;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: vscode.l10n.t('Add Dev Container Here'),
  });
  return picked?.[0]?.fsPath;
}

interface TemplatePick extends vscode.QuickPickItem {
  template: TemplateEntry;
}

async function pickTemplate(
  index: TemplateIndex,
): Promise<TemplateEntry | undefined> {
  const picked = await vscode.window.showQuickPick<TemplatePick>(
    index.templates.map(template => ({
      label: template.name,
      description: template.version,
      detail: template.description,
      template,
    })),
    {
      title: vscode.l10n.t('Add Dev Container Configuration'),
      placeHolder: vscode.l10n.t(
        'Templates that need Docker Compose or a Docker daemon are not listed: Apple container cannot run them',
      ),
      matchOnDetail: true,
      ignoreFocusOut: true,
    },
  );
  return picked?.template;
}

interface ValuePick extends vscode.QuickPickItem {
  value: string;
}

/** One option: a fixed choice, suggestions that also take a typed value, yes/no, or free text */
async function askOption(
  title: string,
  name: string,
  option: TemplateOption,
): Promise<string | undefined> {
  const prompt = option.description ?? name;
  if (option.type === 'string' && !option.enum && !option.proposals) {
    return vscode.window.showInputBox({
      title,
      prompt,
      value: option.default ?? '',
      ignoreFocusOut: true,
    });
  }
  const values =
    option.type === 'boolean'
      ? ['true', 'false']
      : (option.enum ?? option.proposals ?? []);
  const items: ValuePick[] = values.map(value => ({
    label: value,
    description:
      value === option.default ? vscode.l10n.t('default') : undefined,
    value,
  }));
  // The default first, so Enter accepts it
  items.sort((a, b) => Number(!!b.description) - Number(!!a.description));
  if (option.enum || option.type === 'boolean') {
    return (
      await vscode.window.showQuickPick(items, {
        title,
        placeHolder: prompt,
        ignoreFocusOut: true,
      })
    )?.value;
  }
  // Proposals: any other value may be typed
  const qp = vscode.window.createQuickPick<ValuePick>();
  qp.title = title;
  qp.placeholder = prompt;
  qp.ignoreFocusOut = true;
  qp.items = items;
  qp.onDidChangeValue(typed => {
    const value = typed.trim();
    qp.items =
      value && !values.includes(value)
        ? [{label: value, value, alwaysShow: true}, ...items]
        : items;
  });
  return new Promise(resolve => {
    let picked: string | undefined;
    qp.onDidAccept(() => {
      picked = qp.selectedItems[0]?.value;
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(picked);
    });
    qp.show();
  });
}

async function askOptions(
  template: TemplateEntry,
): Promise<Record<string, string> | undefined> {
  const entries = Object.entries(template.options);
  const args: Record<string, string> = {};
  for (const [i, [name, option]] of entries.entries()) {
    const value = await askOption(
      `${template.name} (${i + 1}/${entries.length})`,
      name,
      option,
    );
    if (value === undefined) {
      return undefined;
    }
    args[name] = value;
  }
  return args;
}

interface FeaturePick extends vscode.QuickPickItem {
  feature: FeatureEntry;
}

/** Bundled Features; none is a valid answer */
async function pickFeatures(
  index: TemplateIndex,
): Promise<FeatureEntry[] | undefined> {
  const picked = await vscode.window.showQuickPick<FeaturePick>(
    index.features.map(feature => ({
      label: feature.name,
      description: feature.version,
      detail: feature.description,
      feature,
    })),
    {
      title: vscode.l10n.t('Add Features (optional)'),
      placeHolder: vscode.l10n.t(
        'Tools installed into the dev container; press Enter to add none',
      ),
      canPickMany: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    },
  );
  return picked?.map(p => p.feature);
}

interface AgentPick extends vscode.QuickPickItem {
  agent: CodingAgent;
}

/** Coding agents installed with their official scripts after the container is created; none is a valid answer */
async function pickAgents(): Promise<CodingAgent[] | undefined> {
  const picked = await vscode.window.showQuickPick<AgentPick>(
    CODING_AGENTS.map(agent => ({
      label: agent.name,
      // The exact command, since it downloads and runs a script
      detail: agent.install,
      agent: agent.id,
    })),
    {
      title: vscode.l10n.t('Install Coding Agents (optional)'),
      placeHolder: vscode.l10n.t(
        'Installed by postCreateCommand with their official scripts; press Enter to install none',
      ),
      canPickMany: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    },
  );
  return picked?.map(p => p.agent);
}

interface Choice {
  template: TemplateEntry;
  args: Record<string, string>;
  features: FeatureEntry[];
  agents: CodingAgent[];
}

function fromDirect(index: TemplateIndex, direct: DirectTemplate): Choice {
  const template = index.templates.find(t => t.id === direct.template);
  if (!template) {
    throw new Error(`Template ${direct.template} is not bundled`);
  }
  const features = (direct.features ?? []).map(id => {
    const feature = index.features.find(f => f.id === id);
    if (!feature) {
      throw new Error(`Feature ${id} is not bundled`);
    }
    return feature;
  });
  return {
    template,
    args: direct.args ?? {},
    features,
    agents: direct.agents ?? [],
  };
}

async function ask(index: TemplateIndex): Promise<Choice | undefined> {
  const template = await pickTemplate(index);
  if (!template) {
    return undefined;
  }
  const args = await askOptions(template);
  if (!args) {
    return undefined;
  }
  const features = await pickFeatures(index);
  if (!features) {
    return undefined;
  }
  // Alpine has no bash for the install scripts
  const agents = supportsCodingAgents(template) ? await pickAgents() : [];
  return agents && {template, args, features, agents};
}

/**
 * Adds a devcontainer.json from a bundled Template to a folder and offers to open it in a dev container. Resolves the
 * written configuration, or undefined when stopped early.
 */
export async function addDevContainerConfig(
  ctx: CommandContext,
  uri?: vscode.Uri,
  direct?: DirectTemplate,
): Promise<string | undefined> {
  const folder = await pickFolder(uri);
  if (!folder) {
    return undefined;
  }
  const existing = existingConfigs(folder, existsSync);
  if (existing.length && !direct) {
    const replace = vscode.l10n.t('Replace');
    const open = vscode.l10n.t('Open Existing');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        '{0} already has a dev container configuration.',
        path.basename(folder),
      ),
      {
        modal: true,
        detail: vscode.l10n.t(
          'Replacing writes the Template over {0}.',
          existing.map(f => path.relative(folder, f)).join(', '),
        ),
      },
      replace,
      open,
    );
    if (answer === open) {
      await vscode.window.showTextDocument(vscode.Uri.file(existing[0]));
    }
    if (answer !== replace) {
      return undefined;
    }
  }

  const index = await loadIndex(ctx);
  const choice = direct ? fromDirect(index, direct) : await ask(index);
  if (!choice) {
    return undefined;
  }
  const written = await applyTemplate({
    templateDir: path.join(
      templatesDir(ctx),
      choice.template.id.split('/').pop()!,
    ),
    workspaceFolder: folder,
    template: choice.template,
    args: choice.args,
    features: choice.features,
    agents: choice.agents,
  });
  const config = written.find(f => path.basename(f) === 'devcontainer.json');
  if (!config) {
    return undefined;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(config));
  if (!direct) {
    const openIt = vscode.l10n.t('Open in Dev Container');
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t('Added {0}.', path.relative(folder, config)),
        openIt,
      )
      .then(answer =>
        answer === openIt
          ? vscode.commands.executeCommand(
              'appleContainer.devcontainer.open',
              vscode.Uri.file(config),
            )
          : undefined,
      );
  }
  return config;
}

export function registerDevContainerTemplateCommands(
  ctx: CommandContext,
): void {
  register(
    ctx,
    'appleContainer.devcontainer.addConfig',
    // From the explorer the second argument is the selection (a list of URIs), not a DirectTemplate
    (uri?: vscode.Uri, second?: unknown) =>
      addDevContainerConfig(ctx, uri, asDirectTemplate(second)),
  );
}
