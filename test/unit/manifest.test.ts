import * as assert from 'assert';
import {readFileSync} from 'fs';
import * as path from 'path';

// Compiled to out/test/unit, so the manifest is three levels up
const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
);
const {commands, menus, views} = manifest.contributes;

/**
 * A remote window only installs dev container extensions and offers the dev container window commands, so nothing
 * else of the extension may show there
 */
const localOnly = (when: string | undefined) =>
  when === 'false' ||
  when === '!remoteName' ||
  !!when?.startsWith('!remoteName && (');

/** The commands of a dev container's own Remote-SSH window (src/commands/remoteWindow.ts) */
const REMOTE_WINDOW_WHEN =
  'remoteName == ssh-remote && appleContainer.inDevContainer';
const remoteWindowCommand = (command: string) =>
  command.startsWith('appleContainer.remote.');

describe('manifest', () => {
  it('activates in remote windows, which have no views or commands to activate it', () => {
    assert.ok(manifest.activationEvents.includes('onStartupFinished'));
  });

  it('hides every view in remote windows', () => {
    for (const view of Object.values<{id: string; when?: string}[]>(
      views,
    ).flat()) {
      assert.ok(localOnly(view.when), `${view.id}: ${view.when}`);
    }
  });

  it('hides every command from the command palette in remote windows', () => {
    const palette = new Map<string, string | undefined>(
      menus.commandPalette.map((e: {command: string; when?: string}) => [
        e.command,
        e.when,
      ]),
    );
    for (const {command} of commands) {
      const when = palette.get(command);
      assert.ok(
        remoteWindowCommand(command)
          ? when === REMOTE_WINDOW_WHEN
          : localOnly(when),
        `${command}: ${when}`,
      );
    }
  });

  it('offers the dev container window commands in the remote indicator menu, only in such a window', () => {
    const items: {command: string; when?: string; group: string}[] =
      menus['statusBar/remoteIndicator'];
    assert.deepStrictEqual(
      items.map(i => i.command).sort(),
      commands
        .map((c: {command: string}) => c.command)
        .filter(remoteWindowCommand)
        .sort(),
    );
    for (const item of items) {
      assert.strictEqual(item.when, REMOTE_WINDOW_WHEN, item.command);
      // Format VS Code requires for this menu, or it drops the entry
      assert.match(item.group, /^remote_\d\d_[a-z][a-z0-9+.-]*_.+$/);
    }
  });

  it('hides the explorer and editor menu items in remote windows', () => {
    for (const key of ['explorer/context', 'editor/title/context']) {
      for (const item of menus[key]) {
        assert.ok(localOnly(item.when), `${key} ${item.command}: ${item.when}`);
      }
    }
  });
});
