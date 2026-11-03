import * as assert from 'assert';
import {readFileSync} from 'fs';
import * as path from 'path';

// Compiled to out/test/unit, so the manifest is three levels up
const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
);
const {commands, menus, views} = manifest.contributes;

/** A remote window only installs dev container extensions, so nothing of the extension may show there */
const localOnly = (when: string | undefined) =>
  when === 'false' ||
  when === '!remoteName' ||
  !!when?.startsWith('!remoteName && (');

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
      assert.ok(
        localOnly(palette.get(command)),
        `${command}: ${palette.get(command)}`,
      );
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
