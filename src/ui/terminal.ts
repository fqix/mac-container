// Commands that are interactive or stream output (exec, logs -f, build, pull) run in the integrated terminal

import * as os from 'os';

import * as vscode from 'vscode';

import type { ContainerCli } from '../services/cli';

/** Opens a terminal running the container CLI directly; output stays after the process exits */
export async function openCliTerminal(cli: ContainerCli, name: string, args: string[]): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal({
    name,
    shellPath: await cli.executable(),
    shellArgs: args,
    iconPath: new vscode.ThemeIcon('vm'),
  });
  terminal.show();
  return terminal;
}

/** Runs the CLI as a VS Code task and resolves with its exit code; output goes to the task terminal */
export async function runCliTask(cli: ContainerCli, name: string, args: string[], cwd?: string): Promise<number | undefined> {
  return runTask(name, await cli.executable(), args, cwd);
}

/**
 * Runs any executable as a VS Code task and resolves with its exit code.
 * Without a cwd VS Code falls back to ${workspaceFolder}, which fails in a window with no folder open, so default to the home directory.
 */
export async function runTask(name: string, executable: string, args: string[], cwd?: string): Promise<number | undefined> {
  const task = new vscode.Task(
    { type: 'appleContainer', id: `${name}-${Date.now()}` },
    vscode.TaskScope.Workspace,
    name,
    'Apple Container',
    new vscode.ProcessExecution(executable, args, { cwd: cwd ?? os.homedir() }),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  const execution = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        disposable.dispose();
        resolve(e.exitCode);
      }
    });
  });
}
