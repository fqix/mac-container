// A task terminal the extension writes to itself (CustomExecution + Pseudoterminal): it runs several commands as
// steps, each framed by a start line and a result line with its duration, and streams their output in between.
// Used where one job runs several processes, such as a dev container build followed by the Remote-SSH preparation.

import {spawn, type ChildProcess} from 'child_process';
import {createWriteStream, mkdirSync, type WriteStream} from 'fs';
import * as os from 'os';
import * as path from 'path';
import {StringDecoder} from 'string_decoder';

import * as vscode from 'vscode';

import {formatElapsed, toTerminalText} from '../utils/steps';

/** How long to wait for VS Code to open the terminal before writing anyway (writes before open would be lost) */
const OPEN_TIMEOUT_MS = 10_000;

export interface StepOptions {
  cwd?: string;
  /** Added to VS Code's environment */
  env?: Record<string, string>;
  /** Also writes the step's output to this file, replacing it */
  logFile?: string;
  /**
   * Called when the user stops the step. Killing a local client such as `container exec` does not stop what it
   * runs in the container, so this stops that.
   */
  onCancel?: () => Promise<unknown>;
}

export class StepTerminal {
  private readonly output = new vscode.EventEmitter<string>();
  private readonly exit = new vscode.EventEmitter<number>();
  private readonly opened: Promise<void>;
  private readonly pty: vscode.Pseudoterminal;
  private child: ChildProcess | undefined;
  private onCancel: (() => Promise<unknown>) | undefined;
  private ended = false;
  /** The user closed the terminal or terminated the task */
  private cancelled = false;

  private constructor() {
    let markOpened!: () => void;
    this.opened = new Promise(resolve => (markOpened = resolve));
    this.pty = {
      onDidWrite: this.output.event,
      onDidClose: this.exit.event,
      open: () => markOpened(),
      close: () => {
        if (this.ended) {
          return;
        }
        // Stops the running step; the steps after it are not run
        this.cancelled = true;
        this.ended = true;
        // The step's own cancel goes first: once the local client is gone, what it ran in the container may lose its
        // parent (the install script) and could no longer be found to stop
        const child = this.child;
        const cancel = this.onCancel?.() ?? Promise.resolve();
        void cancel.catch(() => undefined).finally(() => child?.kill());
      },
    };
  }

  /** Starts a task named `name` whose terminal shows the steps; end() finishes it */
  static async start(name: string): Promise<StepTerminal> {
    const terminal = new StepTerminal();
    const task = new vscode.Task(
      {type: 'appleContainer', id: `${name}-${Date.now()}`},
      vscode.TaskScope.Workspace,
      name,
      'Apple Container',
      new vscode.CustomExecution(async () => terminal.pty),
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };
    await vscode.tasks.executeTask(task);
    await Promise.race([
      terminal.opened,
      new Promise(resolve => setTimeout(resolve, OPEN_TIMEOUT_MS)),
    ]);
    return terminal;
  }

  writeLine(text: string): void {
    this.output.fire(toTerminalText(`${text}\n`));
  }

  /**
   * Runs one step and resolves with its exit code (undefined when it could not start).
   * Its stdout and stderr stream into the terminal. Rejects with vscode.CancellationError when the user stopped it.
   */
  async run(
    label: string,
    executable: string,
    args: string[],
    options: StepOptions = {},
  ): Promise<number | undefined> {
    if (this.cancelled) {
      throw new vscode.CancellationError();
    }
    const started = Date.now();
    this.writeLine(`⏳ ${label} ...`);
    const log = openLog(options.logFile);
    this.onCancel = options.onCancel;
    const code = await new Promise<number | undefined>(resolve => {
      const child = spawn(executable, args, {
        cwd: options.cwd ?? os.homedir(),
        env: {...process.env, ...options.env},
      });
      this.child = child;
      for (const stream of [child.stdout, child.stderr]) {
        // A multi-byte character can be split across chunks
        const decoder = new StringDecoder('utf8');
        stream.on('data', (chunk: Buffer) => {
          const text = decoder.write(chunk);
          log?.write(text);
          this.output.fire(toTerminalText(text));
        });
      }
      child.on('error', error => {
        this.writeLine(error.message);
        resolve(undefined);
      });
      child.on('close', exitCode => resolve(exitCode ?? undefined));
    });
    this.child = undefined;
    this.onCancel = undefined;
    log?.end();
    if (this.cancelled) {
      throw new vscode.CancellationError();
    }
    const took = formatElapsed(Date.now() - started);
    this.writeLine(
      code === 0
        ? `✅ ${label} (${took})`
        : `❌ ${label} (${took}, ${vscode.l10n.t('exit code {0}', String(code ?? '?'))})`,
    );
    return code;
  }

  /** Finishes the task; the terminal stays open with its output */
  end(succeeded: boolean): void {
    if (!this.ended) {
      this.ended = true;
      this.exit.fire(succeeded ? 0 : 1);
    }
  }
}

/** A log that cannot be written must not stop the step */
function openLog(file: string | undefined): WriteStream | undefined {
  if (!file) {
    return undefined;
  }
  try {
    mkdirSync(path.dirname(file), {recursive: true});
    const stream = createWriteStream(file, {flags: 'w'});
    stream.on('error', () => undefined);
    return stream;
  } catch {
    return undefined;
  }
}
