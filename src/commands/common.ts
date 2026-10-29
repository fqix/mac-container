import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';
import type { ReadonlyDocumentProvider } from '../ui/documents';
import { showError } from '../utils/i18n';
import type { ServiceMonitor } from '../services/state';
import type { ResourceNode } from '../views/base';
import type { ContainersProvider } from '../views/containers';
import type { ImagesProvider } from '../views/images';
import type { NetworksProvider } from '../views/networks';
import type { RegistriesProvider } from '../views/registries';
import type { VolumesProvider } from '../views/volumes';

export interface CommandContext {
  extension: vscode.ExtensionContext;
  cli: ContainerCli;
  monitor: ServiceMonitor;
  documents: ReadonlyDocumentProvider;
  views: {
    containers: ContainersProvider;
    images: ImagesProvider;
    networks: NetworksProvider;
    volumes: VolumesProvider;
    registries: RegistriesProvider;
  };
  refreshAll(): Promise<void>;
}

/** Registers a command and reports any error it throws */
export function register(ctx: CommandContext, id: string, handler: (...args: any[]) => unknown): void {
  ctx.extension.subscriptions.push(
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await handler(...args);
      } catch (error) {
        showError(error);
      }
    }),
  );
}

/** With multi-select in a tree view, the second argument holds all selected nodes */
export function selection<T>(node: ResourceNode<T> | undefined, nodes: ResourceNode<T>[] | undefined): T[] {
  // Mixed selections (e.g. a compose group plus a container) only keep resource nodes
  const picked = nodes?.length ? nodes : node ? [node] : [];
  return picked.filter((n) => n && 'resource' in n).map((n) => n.resource);
}

export async function confirm(message: string, action: string, detail?: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
  return answer === action;
}

export function withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, task),
  );
}

/** Input box: an empty value counts as cancel (undefined) unless allowEmpty is set for optional fields */
export async function ask(options: vscode.InputBoxOptions & { allowEmpty?: boolean }): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({ ignoreFocusOut: true, ...options });
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || options.allowEmpty ? trimmed : undefined;
}

/** Shows informational CLI output (e.g. space reclaimed by prune) to the user */
export function showOutput(output: string, fallback: string): void {
  const text = output.trim();
  void vscode.window.showInformationMessage(text ? text.split('\n').slice(-3).join(' ') : fallback);
}

/** The CLI runs on this Mac (extensionKind ui), so files of a remote workspace cannot be used; reports it and returns false */
export function isLocal(uri: vscode.Uri): boolean {
  if (uri.scheme === 'file') {
    return true;
  }
  void vscode.window.showErrorMessage(vscode.l10n.t('Only local files can be used. {0} is not on this Mac.', uri.toString()));
  return false;
}
