import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { generateContainerName } from '../utils/names';
import { archiveFileName, schemeArgs } from '../utils/registry';
import { runCliTask } from '../ui/terminal';
import type { ImageSummary } from '../models/types';
import type { ImageNode } from '../views/images';
import { ask, CommandContext, confirm, isLocal, register, selection, showOutput, withProgress } from './common';

const DOCKERFILE_GLOB = '**/{Dockerfile,Containerfile,*.Dockerfile,*.Containerfile,Dockerfile.*,Containerfile.*}';

export function registerImageCommands(ctx: CommandContext): void {
  const { cli } = ctx;

  register(ctx, 'appleContainer.image.pull', async () => {
    const reference = await ask({
      title: vscode.l10n.t('Pull Image'),
      prompt: vscode.l10n.t('Image reference, e.g. alpine:latest or ghcr.io/org/app:1.0'),
      placeHolder: 'alpine:latest',
    });
    if (!reference) {
      return;
    }
    const code = await runCliTask(cli, vscode.l10n.t('Pull {0}', reference), [
      'image',
      'pull',
      '--progress',
      'plain',
      ...schemeArgs(reference, insecureRegistries()),
      reference,
    ]);
    if (code === 0) {
      ctx.views.images.refresh();
    }
  });

  register(ctx, 'appleContainer.image.build', async (uri?: vscode.Uri) => {
    const file = uri instanceof vscode.Uri ? uri : await pickDockerfile();
    if (!file) {
      return;
    }
    // The extension runs locally (extensionKind: ui) and the CLI can only read local files, so Dockerfiles in a remote workspace cannot be built
    if (file.scheme !== 'file') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Only local files can be built. {0} is not on this Mac.', file.toString()),
      );
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(file);
    const defaultTag = `${path.basename(folder?.uri.fsPath ?? path.dirname(file.fsPath)).toLowerCase()}:latest`;
    const tag = await ask({
      title: vscode.l10n.t('Build Image'),
      prompt: vscode.l10n.t('Image name and tag'),
      value: defaultTag,
    });
    if (!tag) {
      return;
    }
    const contextDir = folder?.uri.fsPath ?? path.dirname(file.fsPath);
    const code = await runCliTask(
      cli,
      vscode.l10n.t('Build {0}', tag),
      ['build', '--progress', 'plain', '--file', file.fsPath, '--tag', tag, contextDir],
      contextDir,
    );
    if (code === 0) {
      ctx.views.images.refresh();
      // Not awaited: the build is done, the offer to push stays in the notification
      const push = vscode.l10n.t('Push');
      void vscode.window.showInformationMessage(vscode.l10n.t('Built {0}.', tag), push).then((answer) => {
        if (answer === push) {
          void vscode.commands.executeCommand('appleContainer.image.push', tag);
        }
      });
    }
  });

  // Called from the tree with an image node, or with a reference after a build
  register(ctx, 'appleContainer.image.push', async (target?: ImageNode | string) => {
    const source =
      typeof target === 'string' ? target : (target?.resource.reference ?? (await pickImage(ctx, vscode.l10n.t('Select an image to push'))));
    if (!source) {
      return;
    }
    const shown = typeof target === 'string' ? target : (target?.resource.displayName ?? source);
    const reference = await ask({
      title: vscode.l10n.t('Push {0}', shown),
      prompt: vscode.l10n.t('Push as (registry/repository:tag); a different name tags the image first'),
      value: shown,
    });
    if (!reference) {
      return;
    }
    if (reference !== shown && reference !== source) {
      await cli.run(['image', 'tag', source, reference]);
      ctx.views.images.refresh();
    }
    const code = await runCliTask(cli, vscode.l10n.t('Push {0}', reference), [
      'image',
      'push',
      '--progress',
      'plain',
      ...schemeArgs(reference, insecureRegistries()),
      reference,
    ]);
    if (code === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Pushed {0}.', reference));
    }
  });

  register(ctx, 'appleContainer.image.save', async (node?: ImageNode, nodes?: ImageNode[]) => {
    let references = selection(node, nodes).map((i) => i.reference);
    if (!references.length) {
      const picked = await pickImage(ctx, vscode.l10n.t('Select an image to export'));
      references = picked ? [picked] : [];
    }
    if (!references.length) {
      return;
    }
    const file = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Export Images'),
      defaultUri: vscode.Uri.file(path.join(os.homedir(), archiveFileName(references))),
      filters: { [vscode.l10n.t('OCI image archive')]: ['tar'] },
    });
    if (!file || !isLocal(file)) {
      return;
    }
    await withProgress(vscode.l10n.t('Exporting {0}...', references.join(', ')), () =>
      cli.run(['image', 'save', '--output', file.fsPath, ...references], { timeoutMs: 60 * 60_000 }),
    );
    const reveal = vscode.l10n.t('Reveal in Finder');
    void vscode.window.showInformationMessage(vscode.l10n.t('Exported to {0}.', file.fsPath), reveal).then((answer) => {
      if (answer === reveal) {
        void vscode.commands.executeCommand('revealFileInOS', file);
      }
    });
  });

  // From the view title it asks for archives; from the explorer it gets the clicked .tar file(s)
  register(ctx, 'appleContainer.image.load', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    let files = uris?.length ? uris : uri instanceof vscode.Uri ? [uri] : undefined;
    files ??= await vscode.window.showOpenDialog({
      title: vscode.l10n.t('Import Images'),
      canSelectMany: true,
      defaultUri: vscode.Uri.file(os.homedir()),
      filters: { [vscode.l10n.t('OCI image archive')]: ['tar'] },
    });
    if (!files?.length || !files.every(isLocal)) {
      return;
    }
    const outputs: string[] = [];
    for (const file of files) {
      outputs.push(
        await withProgress(vscode.l10n.t('Importing {0}...', path.basename(file.fsPath)), () =>
          cli.run(['image', 'load', '--input', file.fsPath], { timeoutMs: 60 * 60_000 }),
        ),
      );
    }
    showOutput(outputs.join('\n'), vscode.l10n.t('Images imported.'));
    ctx.views.images.refresh();
  });

  register(ctx, 'appleContainer.image.run', async (node?: ImageNode) => {
    const image = node?.resource.reference ?? (await pickImage(ctx));
    if (!image) {
      return;
    }
    const generated = generateContainerName(new Set((await cli.listContainers()).map((c) => c.id)));
    const name = await ask({
      title: vscode.l10n.t('Run {0}', image),
      prompt: vscode.l10n.t('Container name; leave empty for a random name'),
      value: generated,
      allowEmpty: true,
    });
    if (name === undefined) {
      return;
    }
    const ports = await ask({
      title: vscode.l10n.t('Run {0}', image),
      prompt: vscode.l10n.t('Published ports (optional), comma separated, e.g. 8080:80, 127.0.0.1:8443:443'),
      allowEmpty: true,
    });
    if (ports === undefined) {
      return;
    }
    const script = await ask({
      title: vscode.l10n.t('Run {0}', image),
      prompt: vscode.l10n.t('Command or shell script (optional), run with /bin/sh -c; empty uses the image default'),
      placeHolder: 'apk add curl && exec sleep infinity',
      allowEmpty: true,
    });
    if (script === undefined) {
      return;
    }
    const args = ['run', '--detach', '--name', name || generated];
    for (const p of ports.split(',').map((s) => s.trim()).filter(Boolean)) {
      args.push('--publish', p);
    }
    // --entrypoint replaces the image ENTRYPOINT too, so the script runs as is
    args.push(...(script ? ['--entrypoint', '/bin/sh', image, '-c', script] : [image]));
    await withProgress(vscode.l10n.t('Starting container from {0}...', image), () => cli.run(args, { timeoutMs: 10 * 60_000 }));
    await ctx.refreshAll();
  });

  register(ctx, 'appleContainer.image.tag', async (node?: ImageNode) => {
    if (!node) {
      return;
    }
    const target = await ask({
      title: vscode.l10n.t('Tag {0}', node.resource.displayName),
      prompt: vscode.l10n.t('New image reference'),
      value: node.resource.displayName,
    });
    if (!target || target === node.resource.displayName) {
      return;
    }
    await cli.run(['image', 'tag', node.resource.reference, target]);
    ctx.views.images.refresh();
  });

  register(ctx, 'appleContainer.image.inspect', async (node?: ImageNode) => {
    if (node) {
      await ctx.documents.open(`/image/${node.resource.displayName.replace(/[/:]/g, '_')}.json`, () =>
        cli.inspect('image', [node.resource.reference]),
      );
    }
  });

  register(ctx, 'appleContainer.image.copyName', async (node?: ImageNode) => {
    if (node) {
      await vscode.env.clipboard.writeText(node.resource.reference);
    }
  });

  register(ctx, 'appleContainer.image.delete', async (node?: ImageNode, nodes?: ImageNode[]) => {
    const items = selection(node, nodes);
    if (!items.length) {
      return;
    }
    const list = items.map((i) => i.displayName).join(', ');
    if (!(await confirm(vscode.l10n.t('Delete image {0}?', list), vscode.l10n.t('Delete')))) {
      return;
    }
    // Apple container cannot delete by digest; use the full reference
    await withProgress(vscode.l10n.t('Deleting {0}...', list), () => cli.run(['image', 'delete', ...items.map((i) => i.reference)]));
    ctx.views.images.refresh();
  });

  register(ctx, 'appleContainer.image.prune', async () => {
    const dangling = vscode.l10n.t('Dangling images only');
    const all = vscode.l10n.t('All unused images');
    const choice = await vscode.window.showQuickPick([dangling, all], { title: vscode.l10n.t('Prune Images') });
    if (!choice) {
      return;
    }
    const args = ['image', 'prune', ...(choice === all ? ['--all'] : [])];
    const out = await withProgress(vscode.l10n.t('Pruning images...'), () => cli.run(args));
    showOutput(out, vscode.l10n.t('Images pruned.'));
    ctx.views.images.refresh();
  });
}

async function pickDockerfile(): Promise<vscode.Uri | undefined> {
  const files = await vscode.workspace.findFiles(DOCKERFILE_GLOB, '**/node_modules/**', 50);
  if (files.length === 0) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: vscode.l10n.t('Select a Dockerfile') });
    return picked?.[0];
  }
  if (files.length === 1) {
    return files[0];
  }
  const item = await vscode.window.showQuickPick(
    files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { title: vscode.l10n.t('Select a Dockerfile') },
  );
  return item?.uri;
}

async function pickImage(ctx: CommandContext, title = vscode.l10n.t('Select an image to run')): Promise<string | undefined> {
  const images: ImageSummary[] = await ctx.cli.listImages();
  const item = await vscode.window.showQuickPick(
    images.map((i) => ({ label: i.displayName, description: i.reference, reference: i.reference })),
    { title },
  );
  return item?.reference;
}

function insecureRegistries(): string[] {
  return vscode.workspace.getConfiguration('appleContainer').get<string[]>('insecureRegistries', []);
}

