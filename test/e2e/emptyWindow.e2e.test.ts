// Runs in a window with no folder open: commands that need no workspace must still work there
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const IMAGE = 'docker.io/library/alpine:latest';

describe('Apple Container e2e (no folder open)', function () {
  const window = vscode.window as any;
  const originals = { showErrorMessage: window.showErrorMessage, showInputBox: window.showInputBox };
  let errors: string[] = [];

  before(async () => {
    assert.strictEqual(vscode.workspace.workspaceFolders, undefined, 'this suite must run without a folder');
    await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
  });

  beforeEach(() => {
    errors = [];
  });

  after(() => {
    Object.assign(window, originals);
  });

  // Without a cwd the task used to resolve ${workspaceFolder} and fail before the CLI started
  it('pulls an image', async () => {
    window.showInputBox = async () => IMAGE;
    const exitCodes: (number | undefined)[] = [];
    const listener = vscode.tasks.onDidEndTaskProcess((e) => exitCodes.push(e.exitCode));
    try {
      await vscode.commands.executeCommand('appleContainer.image.pull');
    } finally {
      listener.dispose();
    }
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(exitCodes, [0], 'the pull task must run the CLI and succeed');
  });
});
