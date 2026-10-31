import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cliEnv, dockerWrapper, parseReadConfiguration, prepareDockerWrapper, runDefaults, upArgs, vscodeExtensions } from '../../src/services/devcontainerCli';

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
    assert.deepStrictEqual(cliEnv(paths, ['--memory', '4G']), {
      ELECTRON_RUN_AS_NODE: '1',
      APPLE_CONTAINER_CLI: '/usr/local/bin/container',
      DOCKER_SHIM_RUN_DEFAULTS: '["--memory","4G"]',
    });
  });

  it('sizes the dev container from hostRequirements and the default memory', () => {
    assert.deepStrictEqual(runDefaults(undefined, '4G'), ['--memory', '4G']);
    // The larger of the two wins, as hostRequirements is a minimum
    assert.deepStrictEqual(runDefaults({ cpus: 8, memory: '16gb' }, '4G'), ['--cpus', '8', '--memory', '16G']);
    assert.deepStrictEqual(runDefaults({ memory: '512mb' }, '4G'), ['--memory', '4G']);
    assert.deepStrictEqual(runDefaults({ memory: '1.5gb' }, '1G'), ['--memory', '1536M']);
    // An empty setting leaves the Apple container default unless hostRequirements asks for more
    assert.deepStrictEqual(runDefaults(undefined, ''), []);
    assert.deepStrictEqual(runDefaults({ cpus: 'many', memory: 'lots' }, 'bogus'), []);
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
      extensions: [],
    });
  });

  it('collects extensions from the merged customizations, features first', () => {
    const merged = {
      mergedConfiguration: {
        customizations: {
          vscode: [
            { extensions: ['golang.Go', 'ms-azuretools.vscode-docker'] },
            { settings: { 'go.useLanguageServer': true } },
            { extensions: ['-ms-azuretools.vscode-docker', 'esbenp.prettier-vscode', 'golang.go', ' ', 42] },
          ],
        },
      },
    };
    assert.deepStrictEqual(parseReadConfiguration(JSON.stringify(merged)).extensions, ['golang.go', 'esbenp.prettier-vscode']);
    // An unmerged configuration has a single object
    assert.deepStrictEqual(vscodeExtensions({ extensions: ['ms-python.python'] }), ['ms-python.python']);
    assert.deepStrictEqual(vscodeExtensions(undefined), []);
  });
});
