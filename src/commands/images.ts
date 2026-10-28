import * as path from 'path';
import * as vscode from 'vscode';

import { generateContainerName } from '../utils/names';
import { runCliTask } from '../ui/terminal';
import type { ImageSummary } from '../models/types';
import type { ImageNode } from '../views/images';
import { ask, CommandContext, confirm, register, selection, showOutput, withProgress } from './common';

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
    const code = await runCliTask(cli, vscode.l10n.t('Pull {0}', reference), ['image', 'pull', '--progress', 'plain', reference]);
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
    }
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

async function pickImage(ctx: CommandContext): Promise<string | undefined> {
  const images: ImageSummary[] = await ctx.cli.listImages();
  const item = await vscode.window.showQuickPick(
    images.map((i) => ({ label: i.displayName, description: i.reference, reference: i.reference })),
    { title: vscode.l10n.t('Select an image to run') },
  );
  return item?.reference;
}
