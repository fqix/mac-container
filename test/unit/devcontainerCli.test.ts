import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cliEnv, dockerWrapper, parseReadConfiguration, prepareDockerWrapper, upArgs } from '../../src/services/devcontainerCli';

const paths = {
  node: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
  script: '/ext/dist/devcontainer-cli/run.js',
  dockerPath: '/storage/bin/docker',
  containerCli: '/usr/local/bin/container',
};
const target = { workspaceFolder: '/Users/dev/My App', configFile: '/Users/dev/My App/.devcontainer/devcontainer.json' };

describe('devcontainers/cli integration', () => {
  it('builds the up arguments', () => {
    assert.deepStrictEqual(upArgs(paths, target), [
      '/ext/dist/devcontainer-cli/run.js', 'up',
      '--workspace-folder', '/Users/dev/My App',
      '--config', '/Users/dev/My App/.devcontainer/devcontainer.json',
      '--docker-path', '/storage/bin/docker',
      '--log-format', 'text',
    ]);
    assert.deepStrictEqual(upArgs(paths, target, { removeExisting: true }).slice(-1), ['--remove-existing-container']);
    assert.deepStrictEqual(cliEnv(paths), { ELECTRON_RUN_AS_NODE: '1', APPLE_CONTAINER_CLI: '/usr/local/bin/container' });
  });

  it('writes an executable docker wrapper that quotes paths and forwards arguments', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
    try {
      // A stand-in "node" that prints its arguments, under a path with a space and a quote
      const fakeNode = path.join(dir, "it's node");
      fs.writeFileSync(fakeNode, '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE|$1|$2|$3"\n', { mode: 0o755 });
      const file = await prepareDockerWrapper(dir, fakeNode, '/ext/dist/docker-shim.js');
      assert.strictEqual(file, path.join(dir, 'bin', 'docker'));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), dockerWrapper(fakeNode, '/ext/dist/docker-shim.js'));
      assert.strictEqual(execFileSync(file, ['ps', 'a b'], { encoding: 'utf8' }), '1|/ext/dist/docker-shim.js|ps|a b\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the workspace folder, users and remoteEnv from read-configuration', () => {
    const output = [
      '[2026-10-29T10:00:00.000Z] log line',
      JSON.stringify({
        configuration: { remoteUser: 'ignored' },
        workspace: { workspaceFolder: '/workspaces/my-app' },
        mergedConfiguration: { remoteUser: 'dev', containerUser: 'root', remoteEnv: { A: '${containerEnv:PATH}:/x', B: null } },
      }),
    ].join('\n');
    assert.deepStrictEqual(parseReadConfiguration(output), {
      workspaceFolder: '/workspaces/my-app',
      remoteUser: 'dev',
      containerUser: 'root',
      remoteEnv: { A: '${containerEnv:PATH}:/x' },
    });
  });
});
