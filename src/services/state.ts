// Tracks CLI availability and service state, and mirrors them into context keys used by viewsWelcome

import * as vscode from 'vscode';

import { CliNotFoundError, ContainerCli } from './cli';
import { describeError } from '../utils/i18n';
import type { SystemStatus } from '../models/types';

export type ServiceState =
  | { kind: 'unknown' }
  | { kind: 'cliMissing' }
  | { kind: 'stopped' }
  | { kind: 'running'; status: SystemStatus }
  | { kind: 'error'; message: string };

export class ServiceMonitor implements vscode.Disposable {
  private current: ServiceState = { kind: 'unknown' };
  private pending: Promise<ServiceState> | undefined;
  private readonly kindEmitter = new vscode.EventEmitter<ServiceState>();
  private readonly stateEmitter = new vscode.EventEmitter<ServiceState>();

  /** Fires when the service state kind changes */
  readonly onDidChangeKind = this.kindEmitter.event;
  /** Fires after every check, used to refresh the counts in the status bar */
  readonly onDidUpdate = this.stateEmitter.event;

  constructor(private readonly cli: ContainerCli) {}

  get state(): ServiceState {
    return this.current;
  }

  /** Concurrent callers share a single in-flight check */
  check(): Promise<ServiceState> {
    this.pending ??= this.doCheck().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async doCheck(): Promise<ServiceState> {
    let next: ServiceState;
    try {
      const status = await this.cli.systemStatus();
      next = status.running ? { kind: 'running', status } : { kind: 'stopped' };
    } catch (error) {
      next = error instanceof CliNotFoundError ? { kind: 'cliMissing' } : { kind: 'error', message: describeError(error) };
    }
    const changed = next.kind !== this.current.kind;
    this.current = next;
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'appleContainer.cliMissing', next.kind === 'cliMissing'),
      vscode.commands.executeCommand('setContext', 'appleContainer.serviceStopped', next.kind === 'stopped'),
    ]);
    if (changed) {
      this.kindEmitter.fire(next);
    }
    this.stateEmitter.fire(next);
    return next;
  }

  dispose(): void {
    this.kindEmitter.dispose();
    this.stateEmitter.dispose();
  }
}
