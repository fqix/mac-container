import * as vscode from 'vscode';

import type { MountNode, PortNode } from '../views/containers';
import { CommandContext, register } from './common';

export function registerPortAndMountCommands(ctx: CommandContext): void {
  register(ctx, 'appleContainer.port.open', async (node?: PortNode) => {
    if (node) {
      await vscode.env.openExternal(vscode.Uri.parse(node.url));
    }
  });

  register(ctx, 'appleContainer.port.copyUrl', async (node?: PortNode) => {
    if (node) {
      await vscode.env.clipboard.writeText(node.url);
    }
  });

  register(ctx, 'appleContainer.mount.reveal', async (node?: MountNode) => {
    if (node?.mount.kind === 'bind') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.mount.source));
    }
  });
}
