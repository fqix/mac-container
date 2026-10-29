import * as assert from 'assert';

import {
  buildRunArgs,
  EMPTY_SETTINGS,
  mergeEnv,
  parseDotEnv,
  settingsFromConfig,
  validateSettings,
} from '../../src/services/containerSettings';
import { buildRecreateArgs } from '../../src/services/recreate';

describe('container settings', () => {
  it('builds run arguments for every form field', () => {
    const args = buildRunArgs({
      image: 'alpine',
      name: 'web',
      command: 'echo hi && sleep 1',
      settings: {
        ports: [{ hostAddress: '127.0.0.1', hostPort: 8080, containerPort: 80, proto: 'tcp' }],
        mounts: [{ kind: 'volume', source: 'data', destination: '/data', readOnly: true }],
        env: ['A=1', 'B'],
        networks: ['backend'],
        cpus: '2',
        memory: '512M',
        user: '1000:1000',
        workdir: '/app',
      },
    });
    assert.deepStrictEqual(args, [
      'run', '--detach', '--name', 'web',
      '--env', 'A=1', '--env', 'B',
      '--workdir', '/app', '--user', '1000:1000', '--cpus', '2', '--memory', '512M',
      '--network', 'backend', '--publish', '127.0.0.1:8080:80/tcp', '--volume', 'data:/data:ro',
      '--entrypoint', '/bin/sh', 'alpine', '-c', 'echo hi && sleep 1',
    ]);
    assert.deepStrictEqual(buildRunArgs({ image: 'alpine', name: '', command: '', settings: EMPTY_SETTINGS }), ['run', '--detach', 'alpine']);
  });

  it('reads the editable settings back from an inspect configuration', () => {
    const config = {
      id: 'c',
      image: { reference: 'alpine' },
      initProcess: { environment: ['PATH=/bin'], workingDirectory: '/srv', user: { id: { uid: 1000, gid: 100 } }, executable: 'sleep', arguments: ['9'] },
      resources: { cpus: 2, memoryInBytes: 2 * 1024 ** 3 },
      networks: [{ network: 'default' }, { network: 'backend' }],
    };
    const settings = settingsFromConfig(config, [], []);
    assert.deepStrictEqual(settings, {
      ports: [],
      mounts: [],
      env: ['PATH=/bin'],
      networks: ['default', 'backend'],
      cpus: '2',
      memory: '2048M',
      user: '1000:100',
      workdir: '/srv',
    });
    // Unchanged settings recreate the same process
    const args = buildRecreateArgs(config, settings, { start: true });
    assert.deepStrictEqual(args.slice(-4), ['--entrypoint', 'sleep', 'alpine', '9']);
    assert.ok(args.join(' ').includes('--user 1000:100'));
    // Edited settings replace the originals
    const edited = buildRecreateArgs(config, { ...settings, env: ['PATH=/bin', 'DEBUG=1'], memory: '1G', networks: [] }, { start: true });
    const pairs = (flag: string) => edited.flatMap((a, i) => (a === flag ? [edited[i + 1]] : []));
    assert.deepStrictEqual(pairs('--env'), ['PATH=/bin', 'DEBUG=1']);
    assert.deepStrictEqual(pairs('--memory'), ['1G']);
    assert.deepStrictEqual(pairs('--network'), []);
  });

  it('parses .env files', () => {
    const text = [
      '# comment',
      '',
      'export TOKEN=abc',
      'URL="http://x/?a=1#frag"',
      "SINGLE='keep $HOME'",
      'MULTI="line1\\nline2"',
      'PLAIN=value # trailing comment',
      'EMPTY=',
      'not a pair',
    ].join('\r\n');
    assert.deepStrictEqual(parseDotEnv(text), [
      'TOKEN=abc',
      'URL=http://x/?a=1#frag',
      'SINGLE=keep $HOME',
      'MULTI=line1\nline2',
      'PLAIN=value',
      'EMPTY=',
    ]);
  });

  it('merges environment entries by key', () => {
    assert.deepStrictEqual(mergeEnv(['A=1', 'B=2'], ['B=3', 'C=4']), ['A=1', 'B=3', 'C=4']);
  });

  it('validates names, environment, resources and the working directory', () => {
    const problems = validateSettings(
      { ...EMPTY_SETTINGS, env: ['GOOD=1', '1BAD=2', 'BARE'], cpus: '0', memory: '1.5G', workdir: 'relative' },
      '-bad',
    );
    assert.deepStrictEqual(
      problems.map((p) => `${p.section}[${p.index}] ${p.reason}`),
      ['name[0] name', 'env[1] envName', 'resources[0] cpus', 'resources[1] memory', 'process[0] workdir'],
    );
    assert.deepStrictEqual(validateSettings({ ...EMPTY_SETTINGS, cpus: '4', memory: '2g', workdir: '/app' }, ''), []);
  });
});
