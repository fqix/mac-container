import * as vscode from 'vscode';

import type { RegistryNode } from '../views/registries';
import { ask, CommandContext, confirm, register, selection, withProgress } from './common';

// Same host pattern the CLI validates against (RegistryResource.nameValid)
const HOST_PATTERN =
  /^(?:(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])(?:\.(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]))*|\[[a-fA-F0-9:]+\])(?::[0-9]+)?$/;

export function registerRegistryCommands(ctx: CommandContext): void {
  const { cli } = ctx;

  register(ctx, 'appleContainer.registry.login', async () => {
    const title = vscode.l10n.t('Log In to Registry');
    const server = await ask({
      title,
      prompt: vscode.l10n.t('Registry server, e.g. ghcr.io or localhost:5000'),
      placeHolder: 'docker.io',
      validateInput: (v) => (!v.trim() || HOST_PATTERN.test(v.trim()) ? undefined : vscode.l10n.t('Not a valid registry hostname')),
    });
    if (!server) {
      return;
    }
    const username = await ask({ title, prompt: vscode.l10n.t('Username for {0}', server) });
    if (!username) {
      return;
    }
    const password = await vscode.window.showInputBox({
      title,
      prompt: vscode.l10n.t('Password or access token for {0}', username),
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      return;
    }
    await withProgress(vscode.l10n.t('Logging in to {0}...', server), () => cli.registryLogin(server, username, password));
    void vscode.window.showInformationMessage(vscode.l10n.t('Logged in to {0} as {1}.', server, username));
    ctx.views.registries.refresh();
  });

  register(ctx, 'appleContainer.registry.logout', async (node?: RegistryNode, nodes?: RegistryNode[]) => {
    const items = selection(node, nodes);
    if (!items.length) {
      return;
    }
    const list = items.map((r) => r.hostname).join(', ');
    if (!(await confirm(vscode.l10n.t('Log out from {0}?', list), vscode.l10n.t('Log Out')))) {
      return;
    }
    // logout takes a single registry
    for (const r of items) {
      await cli.run(['registry', 'logout', r.hostname]);
    }
    ctx.views.registries.refresh();
  });

  register(ctx, 'appleContainer.registry.copyHostname', async (node?: RegistryNode) => {
    if (node) {
      await vscode.env.clipboard.writeText(node.resource.hostname);
    }
  });
}
