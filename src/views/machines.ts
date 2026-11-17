import * as vscode from 'vscode';

import type {ContainerCli} from '../services/cli';
import {isMachineUnsupported} from '../services/machine';
import type {ServiceMonitor} from '../services/state';
import {relativeTime} from '../utils/i18n';
import {formatBytes} from '../utils/parse';
import type {MachineSummary} from '../models/types';
import {ResourceNode, ResourceProvider} from './base';
import {stateLabel} from './containers';

export type MachineNode = ResourceNode<MachineSummary>;

export class MachinesProvider extends ResourceProvider<MachineSummary> {
  constructor(
    monitor: ServiceMonitor,
    private readonly cli: ContainerCli,
  ) {
    super(monitor);
  }

  protected async fetch(): Promise<MachineSummary[]> {
    try {
      return (await this.cli.listMachines()).sort((a, b) =>
        a.id.localeCompare(b.id),
      );
    } catch (error) {
      // A CLI without `container machine` hides the view (package.json `when`)
      if (isMachineUnsupported(error)) {
        await vscode.commands.executeCommand(
          'setContext',
          'appleContainer.machinesUnsupported',
          true,
        );
        return [];
      }
      throw error;
    }
  }

  protected toNode(machine: MachineSummary): MachineNode {
    const running = machine.status === 'running';
    const node = new ResourceNode(machine, machine.id);
    node.id = `machine:${machine.id}`;
    // machine.<status>, plus .default for the default machine
    node.contextValue = `machine.${running ? 'running' : 'stopped'}${machine.isDefault ? '.default' : ''}`;
    node.iconPath = new vscode.ThemeIcon(
      'server-environment',
      running ? new vscode.ThemeColor('testing.iconPassed') : undefined,
    );
    const resources = resourcesLabel(machine);
    node.description = [
      stateLabel(machine.status),
      resources,
      machine.isDefault ? vscode.l10n.t('Default') : undefined,
    ]
      .filter(Boolean)
      .join(' · ');

    const md = new vscode.MarkdownString();
    md.appendMarkdown('**')
      .appendText(machine.id)
      .appendMarkdown('** — ')
      .appendText(stateLabel(machine.status))
      .appendMarkdown('\n\n');
    const rows: [string, string | undefined][] = [
      [vscode.l10n.t('Default'), machine.isDefault ? vscode.l10n.t('Yes') : ''],
      [vscode.l10n.t('Resources'), resources],
      [vscode.l10n.t('IP Address'), machine.ipv4],
      [
        vscode.l10n.t('Disk Usage'),
        machine.diskBytes !== undefined
          ? formatBytes(machine.diskBytes)
          : undefined,
      ],
      [
        vscode.l10n.t('Created'),
        machine.createdAt && relativeTime(machine.createdAt),
      ],
    ];
    for (const [k, v] of rows) {
      if (v) {
        md.appendMarkdown(`- ${k}: `).appendText(v).appendMarkdown('\n');
      }
    }
    node.tooltip = md;
    return node;
  }
}

function resourcesLabel(machine: MachineSummary): string | undefined {
  if (machine.cpus === undefined || machine.memoryBytes === undefined) {
    return undefined;
  }
  return vscode.l10n.t(
    '{0} CPUs, {1} memory',
    machine.cpus,
    formatBytes(machine.memoryBytes),
  );
}
