// UI-side text helpers: localized error messages and time formatting in the VS Code display language

import * as vscode from 'vscode';

import { CliError, CliNotFoundError, cliErrorDetail } from '../services/cli';
import { formatRelativeTime } from './parse';

export function describeError(error: unknown): string {
  if (error instanceof CliNotFoundError) {
    return vscode.l10n.t('container CLI not found: {0}', error.configuredPath);
  }
  if (error instanceof CliError) {
    return vscode.l10n.t('`container {0}` failed: {1}', error.args.join(' '), cliErrorDetail(error.stderr, error.exitCode));
  }
  return error instanceof Error ? error.message : String(error);
}

export function relativeTime(iso: string | undefined): string {
  return formatRelativeTime(iso, vscode.env.language);
}

export function showError(error: unknown): void {
  void vscode.window.showErrorMessage(describeError(error));
}
