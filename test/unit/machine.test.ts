import * as assert from 'assert';
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {CliError, type ContainerCli} from '../../src/services/cli';
import {
  defaultMachineName,
  isMachineUnsupported,
  isValidMachineName,
  isValidMemory,
  machineCreateArgs,
  machineRunArgs,
  machineSetArgs,
  machineStartArgs,
  memoryValue,
  shellJoin,
} from '../../src/services/machine';
import {
  machineHostAlias,
  machineTarget,
  proxyCommand,
  renderConfig,
} from '../../src/services/remoteSsh';
import {
  parseJson,
  parseMachineInspect,
  parseMachines,
} from '../../src/utils/parse';

// Compiled to out/test/unit, fixtures stay in the source tree
const fixture = (name: string) =>
  parseJson(
    fs.readFileSync(
      path.resolve(__dirname, '../../../test/fixtures', name),
      'utf8',
    ),
  );

describe('machine', () => {
  it('parses machine list output', () => {
    const [dev, stopped] = parseMachines(fixture('machines.json'));
    assert.deepStrictEqual(dev, {
      id: 'dev',
      status: 'running',
      isDefault: true,
      ipv4: '192.168.64.3',
      cpus: 2,
      memoryBytes: 1073741824,
      diskBytes: 44072960,
      createdAt: '2026-11-17T09:38:47Z',
    });
    assert.strictEqual(stopped.status, 'stopped');
    assert.strictEqual(stopped.isDefault, false);
    // A stopped machine has no address
    assert.strictEqual(stopped.ipv4, undefined);
    assert.deepStrictEqual(parseMachines([]), []);
  });

  it('parses machine inspect output', () => {
    const details = parseMachineInspect(fixture('machine.inspect.json'));
    assert.ok(details);
    assert.strictEqual(details.id, 'dev');
    assert.strictEqual(details.image, 'docker.io/library/alpine:latest');
    assert.strictEqual(details.platform, 'linux/arm64');
    assert.strictEqual(details.username, 'alice');
    assert.strictEqual(details.home, '/home/alice');
    assert.strictEqual(details.homeMount, 'rw');
    assert.strictEqual(details.containerId, 'dev-2a02a8');
    // inspect has no default field
    assert.strictEqual(details.isDefault, false);
    assert.strictEqual(parseMachineInspect([]), undefined);
  });

  it('validates names like MachineConfiguration', () => {
    for (const ok of ['dev', 'ubuntu-24', 'a', '1x']) {
      assert.ok(isValidMachineName(ok), ok);
    }
    for (const bad of ['', 'Dev', '-dev', 'dev-', 'my_dev', 'a.b']) {
      assert.ok(!isValidMachineName(bad), bad);
    }
  });

  it('suggests the name machine create would pick', () => {
    assert.strictEqual(defaultMachineName('alpine:3.22'), 'alpine-3-22');
    assert.strictEqual(defaultMachineName('alpine'), 'alpine-latest');
    assert.strictEqual(
      defaultMachineName('localhost:5000/team/ubuntu-machine:24.04'),
      'ubuntu-machine-24-04',
    );
    assert.ok(isValidMachineName(defaultMachineName('Ghcr.io/x/My_Img:V1')));
  });

  it('builds create and set arguments', () => {
    assert.deepStrictEqual(
      machineCreateArgs({
        image: 'localhost:5000/dev:1',
        name: 'dev',
        cpus: 4,
        memory: '8G',
        homeMount: 'ro',
        setDefault: true,
        registryArgs: ['--scheme', 'http'],
      }),
      [
        'machine',
        'create',
        '--name',
        'dev',
        '--cpus',
        '4',
        '--memory',
        '8G',
        '--home-mount',
        'ro',
        '--set-default',
        '--progress',
        'plain',
        '--scheme',
        'http',
        'localhost:5000/dev:1',
      ],
    );
    assert.deepStrictEqual(
      machineCreateArgs({image: 'alpine:latest', name: 'a'}),
      [
        'machine',
        'create',
        '--name',
        'a',
        '--progress',
        'plain',
        'alpine:latest',
      ],
    );
    assert.deepStrictEqual(
      machineSetArgs('dev', {cpus: 2, memory: '4G', homeMount: 'none'}),
      [
        'machine',
        'set',
        '--name',
        'dev',
        'cpus=2',
        'memory=4G',
        'home-mount=none',
      ],
    );
    assert.strictEqual(machineSetArgs('dev', {}), undefined);
  });

  it('formats and validates memory sizes', () => {
    assert.strictEqual(memoryValue(8 * 1024 ** 3), '8G');
    assert.strictEqual(memoryValue(1536 * 1024 ** 2), '1536M');
    for (const ok of ['8G', '8g', '1536M', '2gb', '1.5G']) {
      assert.ok(isValidMemory(ok), ok);
    }
    for (const bad of ['', 'G', 'lots', '-1G']) {
      assert.ok(!isValidMemory(bad), bad);
    }
  });

  it('passes a command to machine run as one shell command line', () => {
    assert.deepStrictEqual(
      machineRunArgs('dev', ['sh', '-c', 'echo "$1"', 'sh', 'a b'], {
        stdin: true,
        root: true,
      }),
      [
        'machine',
        'run',
        '--name',
        'dev',
        '--interactive',
        '--root',
        '--',
        `sh -c 'echo "$1"' sh 'a b'`,
      ],
    );
    assert.deepStrictEqual(machineRunArgs('dev', ['id'], {user: 'alice'}), [
      'machine',
      'run',
      '--name',
      'dev',
      '--user',
      'alice',
      '--',
      'id',
    ]);
    assert.deepStrictEqual(machineStartArgs('dev'), [
      'machine',
      'run',
      '--name',
      'dev',
      '--',
      'true',
    ]);
  });

  it('quotes words so that the login shell of the machine gets them back unchanged', () => {
    const argv = ['printf', '%s|', 'a b', "it's", '$HOME', '`id`', '', 'x\ny'];
    // The machine's init runs `<shell> -c "$*"`
    const out = execFileSync('/bin/sh', ['-c', shellJoin(argv)], {
      encoding: 'utf8',
    });
    assert.strictEqual(out, "a b|it's|$HOME|`id`||x\ny|");
  });

  it('recognizes a CLI without container machine', () => {
    const unknown = new CliError(
      ['machine', 'list'],
      64,
      "Error: unknown command 'machine'\n",
    );
    assert.ok(isMachineUnsupported(unknown));
    assert.ok(
      !isMachineUnsupported(new CliError(['machine', 'list'], 1, 'boom')),
    );
    assert.ok(!isMachineUnsupported(new Error("unknown command 'machine'")));
  });
});

describe('machines over Remote-SSH', () => {
  const cli = {executable: async () => '/x/container'} as ContainerCli;

  it('reaches a machine through machine run, as root for sshd', () => {
    const target = machineTarget(cli, 'Dev');
    assert.strictEqual(target.alias, 'machine.dev');
    assert.strictEqual(machineHostAlias('Dev'), 'machine.dev');
    assert.strictEqual(target.switchesUser, true);
    assert.strictEqual(target.machine, true);
    const command = proxyCommand(
      '/x/container',
      (argv, options) => target.exec(argv, options),
      '/usr/sbin/sshd',
    );
    assert.strictEqual(
      command,
      '"/x/container" machine run --name Dev --interactive --root -- "/usr/sbin/sshd -i -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no -o AuthorizedKeysFile=.ssh/authorized_keys -o PermitUserEnvironment=yes"',
    );
    const text = renderConfig([], '/x/container', '/k', [
      {
        alias: target.alias,
        hostName: 'Dev',
        user: 'alice',
        proxyCommand: command,
      },
    ]);
    assert.match(text, /^Host machine\.dev$/m);
    assert.match(text, /^ {2}User alice$/m);
    assert.match(text, /^ {2}ProxyCommand "\/x\/container" machine run /m);
  });
});
