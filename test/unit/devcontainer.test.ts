import * as assert from 'assert';

import {
  commandSteps,
  findConfigFiles,
  memorySpec,
  mountSpec,
  parseConfig,
  planDevContainer,
  execArgs,
  localFolderOf,
  substitute,
} from '../../src/services/devcontainer';

const folder = '/Users/dev/projects/My App';
const vars = { localWorkspaceFolder: folder, containerWorkspaceFolder: '/workspaces/My App', devcontainerId: 'abc', localEnv: { HOME: '/Users/dev' } };

function plan(config: Record<string, unknown>, extra: { dockerfileText?: string } = {}) {
  return planDevContainer({
    config,
    configFile: `${folder}/.devcontainer/devcontainer.json`,
    configText: JSON.stringify(config),
    localWorkspaceFolder: folder,
    localEnv: { HOME: '/Users/dev', TOKEN: 's3cret' },
    ...extra,
  });
}

/** Values following each occurrence of a flag */
const values = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe('devcontainer.json', () => {
  it('finds configuration files in the spec order', () => {
    const files = new Set([
      '/w/.devcontainer.json',
      '/w/.devcontainer/devcontainer.json',
      '/w/.devcontainer',
      '/w/.devcontainer/python/devcontainer.json',
      '/w/.devcontainer/node/devcontainer.json',
    ]);
    const found = findConfigFiles('/w', (p) => files.has(p), () => ['python', 'node', 'devcontainer.json']);
    assert.deepStrictEqual(found, [
      '/w/.devcontainer/devcontainer.json',
      '/w/.devcontainer.json',
      '/w/.devcontainer/node/devcontainer.json',
      '/w/.devcontainer/python/devcontainer.json',
    ]);
    assert.deepStrictEqual(findConfigFiles('/none', () => false), []);
  });

  it('parses JSON with comments and trailing commas, reporting the line of an error', () => {
    assert.deepStrictEqual(parseConfig('{\n  // image\n  "image": "alpine", /* inline */\n  "forwardPorts": [3000,],\n}', 'f'), {
      image: 'alpine',
      forwardPorts: [3000],
    });
    assert.throws(() => parseConfig('{\n  "image": "alpine"\n  "name": "x"\n}', 'devcontainer.json'), /devcontainer\.json:3:/);
  });

  it('substitutes variables, leaving containerEnv for the container', () => {
    assert.deepStrictEqual(
      substitute(
        {
          a: '${localWorkspaceFolder}/src',
          b: ['${localWorkspaceFolderBasename}', '${containerWorkspaceFolder}', '${containerWorkspaceFolderBasename}'],
          c: '${localEnv:HOME}/.cache ${localEnv:MISSING} ${localEnv:MISSING:fallback} ${env:HOME}',
          d: '${containerEnv:PATH}:/opt/bin ${devcontainerId}',
          n: 3,
        },
        vars,
      ),
      {
        a: `${folder}/src`,
        b: ['My App', '/workspaces/My App', 'My App'],
        c: '/Users/dev/.cache  fallback /Users/dev',
        d: '${containerEnv:PATH}:/opt/bin abc',
        n: 3,
      },
    );
  });

  it('converts Docker mount strings and mount objects to the CLI format', () => {
    assert.strictEqual(mountSpec('source=/a,target=/b,type=bind,consistency=cached'), 'type=bind,source=/a,target=/b');
    assert.strictEqual(mountSpec('src=cache,dst=/root/.cache,type=volume,readonly'), 'type=volume,source=cache,target=/root/.cache,readonly');
    assert.strictEqual(mountSpec({ source: 'data', target: '/data', type: 'volume' }), 'type=volume,source=data,target=/data');
    assert.strictEqual(mountSpec('type=tmpfs,destination=/tmp/x'), 'type=tmpfs,target=/tmp/x');
  });

  it('converts hostRequirements memory to CLI sizes', () => {
    assert.strictEqual(memorySpec('4gb'), '4G');
    assert.strictEqual(memorySpec('512MB'), '512M');
    assert.strictEqual(memorySpec('1.5gb'), '1536M');
    assert.strictEqual(memorySpec('lots'), undefined);
  });

  it('turns lifecycle commands into steps', () => {
    assert.deepStrictEqual(commandSteps('npm ci && npm test'), [{ argv: ['/bin/sh', '-c', 'npm ci && npm test'] }]);
    assert.deepStrictEqual(commandSteps(['npm', 'ci']), [{ argv: ['npm', 'ci'] }]);
    assert.deepStrictEqual(commandSteps({ server: 'npm start', db: ['redis-server'] }), [
      { label: 'server', argv: ['/bin/sh', '-c', 'npm start'] },
      { label: 'db', argv: ['redis-server'] },
    ]);
    assert.deepStrictEqual(commandSteps(undefined), []);
    assert.deepStrictEqual(commandSteps(''), []);
  });

  it('plans an image-based container with the default workspace mount and settings', () => {
    const p = plan({
      name: 'Web',
      image: 'mcr.microsoft.com/devcontainers/base:alpine',
      containerEnv: { TOKEN: '${localEnv:TOKEN}', WS: '${containerWorkspaceFolder}' },
      mounts: ['source=${localEnv:HOME}/.npm,target=/root/.npm,type=bind,consistency=cached'],
      forwardPorts: [3000, 'localhost:5173', 'db:5432'],
      appPort: ['8080:80'],
      remoteUser: 'node',
      hostRequirements: { cpus: 4, memory: '8gb' },
      capAdd: ['SYS_PTRACE'],
      init: true,
      runArgs: ['--dns', '1.1.1.1'],
      postCreateCommand: 'npm ci',
    });
    assert.strictEqual(p.name, 'Web');
    assert.match(p.containerName, /^devc-my-app-[0-9a-f]{8}$/);
    assert.strictEqual(p.workspaceFolder, '/workspaces/My App');
    assert.strictEqual(p.remoteUser, 'node');
    assert.strictEqual(p.build, undefined);
    const args = p.runArgs;
    assert.deepStrictEqual(args.slice(0, 4), ['run', '--detach', '--name', p.containerName]);
    assert.deepStrictEqual(values(args, '--mount'), [
      `type=bind,source=${folder},target=/workspaces/My App`,
      'type=bind,source=/Users/dev/.npm,target=/root/.npm',
    ]);
    assert.deepStrictEqual(values(args, '--env'), ['TOKEN=s3cret', 'WS=/workspaces/My App']);
    // Only numeric forwardPorts can be published; compose service ports are skipped
    assert.deepStrictEqual(values(args, '--publish'), ['127.0.0.1:3000:3000', '127.0.0.1:5173:5173', '8080:80']);
    assert.deepStrictEqual(values(args, '--cpus'), ['4']);
    assert.deepStrictEqual(values(args, '--memory'), ['8G']);
    assert.deepStrictEqual(values(args, '--cap-add'), ['SYS_PTRACE']);
    assert.ok(args.includes('--init'));
    assert.deepStrictEqual(values(args, '--label').map((l) => l.split('=')[0]), [
      'devcontainer.local_folder',
      'devcontainer.config_file',
      'apple-container.devcontainer.hash',
    ]);
    // runArgs pass through before the image; overrideCommand keeps the container alive with a shell loop
    assert.deepStrictEqual(values(args, '--dns'), ['1.1.1.1']);
    assert.deepStrictEqual(args.slice(-5, -1), ['--entrypoint', '/bin/sh', 'mcr.microsoft.com/devcontainers/base:alpine', '-c']);
    assert.deepStrictEqual(p.lifecycle, { postCreateCommand: [{ argv: ['/bin/sh', '-c', 'npm ci'] }] });
    assert.deepStrictEqual(p.unsupported, []);
  });

  it('plans a Dockerfile build relative to the config file and honours workspace overrides', () => {
    const p = plan(
      {
        build: { dockerfile: 'Dockerfile', context: '..', args: { VARIANT: '3.12' }, target: 'dev' },
        workspaceMount: 'source=${localWorkspaceFolder},target=/src,type=bind',
        workspaceFolder: '/src',
        overrideCommand: false,
        containerUser: 'dev',
      },
      { dockerfileText: 'FROM python' },
    );
    assert.ok(p.build);
    assert.match(p.image, /^vsc-my-app-[0-9a-f]{8}:latest$/);
    assert.deepStrictEqual(p.build.args, [
      'build', '--progress', 'plain',
      '--file', `${folder}/.devcontainer/Dockerfile`,
      '--tag', p.image,
      '--build-arg', 'VARIANT=3.12',
      '--target', 'dev',
      folder,
    ]);
    assert.strictEqual(p.workspaceFolder, '/src');
    assert.deepStrictEqual(values(p.runArgs, '--mount'), [`type=bind,source=${folder},target=/src`]);
    assert.deepStrictEqual(values(p.runArgs, '--user'), ['dev']);
    assert.strictEqual(p.remoteUser, 'dev');
    // overrideCommand false runs the image command
    assert.strictEqual(p.runArgs[p.runArgs.length - 1], p.image);
  });

  it('changes the config hash when the configuration or the Dockerfile changes', () => {
    const base = { build: { dockerfile: 'Dockerfile' } };
    const a = plan(base, { dockerfileText: 'FROM a' });
    assert.strictEqual(plan(base, { dockerfileText: 'FROM a' }).configHash, a.configHash);
    assert.notStrictEqual(plan(base, { dockerfileText: 'FROM b' }).configHash, a.configHash);
    assert.notStrictEqual(plan({ ...base, name: 'x' }, { dockerfileText: 'FROM a' }).configHash, a.configHash);
    // The container name depends only on the folder and config file, so a rebuild replaces the same container
    assert.strictEqual(plan({ ...base, name: 'x' }).containerName, a.containerName);
  });

  it('lists properties Apple container cannot apply and rejects configs without an image', () => {
    const p = plan({
      image: 'alpine',
      features: { 'ghcr.io/devcontainers/features/node:1': {} },
      privileged: true,
      securityOpt: ['seccomp=unconfined'],
      customizations: { vscode: { extensions: ['ms-python.python'] } },
    });
    assert.deepStrictEqual(p.unsupported, ['features', 'privileged', 'securityOpt', 'customizations.vscode.extensions']);
    assert.throws(() => plan({ dockerComposeFile: 'compose.yml', service: 'app' }), /dockerComposeFile is not supported/);
    assert.throws(() => plan({ name: 'empty' }), /needs an image or a build/);
  });

  it('finds the local folder of a configuration file', () => {
    assert.strictEqual(localFolderOf('/w/app/.devcontainer/devcontainer.json'), '/w/app');
    assert.strictEqual(localFolderOf('/w/app/.devcontainer/python/devcontainer.json'), '/w/app');
    assert.strictEqual(localFolderOf('/w/app/.devcontainer.json'), '/w/app');
  });

  it('runs lifecycle steps in the workspace folder as the remote user with remoteEnv', () => {
    const p = { containerName: 'devc-x', workspaceFolder: '/workspaces/x', remoteUser: 'node' };
    assert.deepStrictEqual(execArgs(p, { argv: ['/bin/sh', '-c', 'npm ci'] }, { CI: '1' }), [
      'exec', '--workdir', '/workspaces/x', '--user', 'node', '--env', 'CI=1', 'devc-x', '/bin/sh', '-c', 'npm ci',
    ]);
    assert.deepStrictEqual(execArgs({ ...p, remoteUser: undefined }, { argv: ['make'] }), ['exec', '--workdir', '/workspaces/x', 'devc-x', 'make']);
  });
});
