import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type {ContainerCli} from '../../src/services/cli';
import {parseContainers} from '../../src/utils/parse';
import {
  containerOfAuthority,
  containerTarget,
  POD_SSHD_ARGS,
  PodNotRootError,
  podHostAlias,
  podTarget,
  prepareTarget,
  proxyCommand,
  withPrelude,
  ensureUserConfigIncluded,
  hostAlias,
  type InstallCommand,
  InstallFailedError,
  installPackages,
  NoPackageManagerError,
  isIncluded,
  missingPackages,
  parsePrepareOutput,
  renderConfig,
} from '../../src/services/remoteSsh';

describe('remote ssh', () => {
  const home = '/Users/dev';
  const target = '/Users/dev/.ssh/apple-container/config';

  it('builds lowercase host aliases', () => {
    assert.strictEqual(hostAlias('My-App'), 'apple-container.my-app');
  });

  it('finds the container of a Remote-SSH window authority', () => {
    const ids = ['devc-app-1a2b', 'My-App'];
    assert.strictEqual(
      containerOfAuthority('ssh-remote+apple-container.devc-app-1a2b', ids),
      'devc-app-1a2b',
    );
    assert.strictEqual(
      containerOfAuthority('ssh-remote+apple-container.my-app', ids),
      'My-App',
    );
    assert.strictEqual(
      containerOfAuthority('ssh-remote+devbox', ids),
      undefined,
    );
    assert.strictEqual(
      containerOfAuthority('dev-container+apple-container.my-app', ids),
      undefined,
    );
  });

  it('renders one host block per container with a ProxyCommand through the CLI', () => {
    const text = renderConfig(
      [{id: 'web', sshd: '/usr/sbin/sshd', user: 'node'}],
      '/opt/homebrew/bin/container',
    );
    assert.match(text, /^Host apple-container\.web$/m);
    assert.match(text, /^ {2}User node$/m);
    assert.match(
      text,
      /^ {2}ProxyCommand "\/opt\/homebrew\/bin\/container" exec -i -u 0 web \/usr\/sbin\/sshd -i /m,
    );
  });

  it('detects Include directives in their common spellings', () => {
    assert.ok(
      isIncluded(
        'Include ~/.ssh/apple-container/config\nHost *\n',
        home,
        target,
      ),
    );
    assert.ok(isIncluded('  include apple-container/config', home, target));
    assert.ok(
      isIncluded('Include "/Users/dev/.ssh/apple-container/*"', home, target),
    );
    assert.ok(
      isIncluded(
        'Include ~/.ssh/other ~/.ssh/apple-container/config',
        home,
        target,
      ),
    );
    assert.ok(
      isIncluded(
        'Include=~/.ssh/apple-container/config # containers',
        home,
        target,
      ),
    );
  });

  it('ignores unrelated or commented Include lines', () => {
    assert.ok(!isIncluded('', home, target));
    assert.ok(
      !isIncluded('# Include ~/.ssh/apple-container/config', home, target),
    );
    assert.ok(!isIncluded('Include ~/.ssh/config.d/*', home, target));
    assert.ok(
      !isIncluded(
        'Include ~/.ssh/other # ~/.ssh/apple-container/config',
        home,
        target,
      ),
    );
  });

  it('does not treat an Include inside a Host or Match block as global', () => {
    assert.ok(
      !isIncluded(
        'Host example\n  Include ~/.ssh/apple-container/config',
        home,
        target,
      ),
    );
    assert.ok(
      !isIncluded(
        'Match host example\n  Include ~/.ssh/apple-container/config',
        home,
        target,
      ),
    );
    assert.ok(
      !isIncluded(
        'Host=example\n  Include ~/.ssh/apple-container/config',
        home,
        target,
      ),
    );
  });

  it('parses the prepare script output', () => {
    assert.deepStrictEqual(
      parsePrepareOutput(
        'sshd=/usr/bin/sshd\nuser=dev\nhome=/home/dev\ndownloader=no\nbash=no\n',
      ),
      {
        sshd: '/usr/bin/sshd',
        user: 'dev',
        home: '/home/dev',
        downloader: false,
        bash: false,
      },
    );
    assert.deepStrictEqual(parsePrepareOutput(''), {
      sshd: '/usr/sbin/sshd',
      user: 'root',
      home: '/',
      downloader: true,
      bash: true,
    });
  });

  it('installs what Remote-SSH needs and the container lacks in one go', () => {
    const base = {sshd: '/usr/sbin/sshd', user: 'root', home: '/root'};
    // BusyBox-only images such as Alpine have neither bash nor a working wget
    assert.deepStrictEqual(
      missingPackages({...base, bash: false, downloader: false}),
      ['bash', 'wget', 'ca-certificates'],
    );
    assert.deepStrictEqual(
      missingPackages({...base, bash: false, downloader: true}),
      ['bash'],
    );
    assert.deepStrictEqual(
      missingPackages({...base, bash: true, downloader: true}),
      [],
    );
  });

  it('reads the container process user', () => {
    const user = (u: unknown) =>
      parseContainers([{id: 'c', configuration: {initProcess: {user: u}}}])[0]
        .user;
    assert.strictEqual(user({raw: {userString: 'node:staff'}}), 'node:staff');
    assert.strictEqual(user({id: {uid: 1000, gid: 1000}}), '1000');
    assert.strictEqual(user(undefined), undefined);
  });
});

describe('automatic SSH config inclusion', () => {
  let tmp: string;
  let userConfig: string;
  let target: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), 'apple-container-ssh-config-'),
    );
    userConfig = path.join(tmp, 'config');
    target = path.join(tmp, 'managed hosts', 'config');
  });

  afterEach(async () => {
    await fs.rm(tmp, {recursive: true, force: true});
  });

  it('creates a missing custom config and its parent directory with private permissions', async () => {
    userConfig = path.join(tmp, 'custom', 'config');
    await ensureUserConfigIncluded(userConfig, target);
    assert.strictEqual(
      await fs.readFile(userConfig, 'utf8'),
      `Include "${target}"\n`,
    );
    assert.strictEqual((await fs.stat(userConfig)).mode & 0o777, 0o600);
    assert.strictEqual(
      (await fs.stat(path.dirname(userConfig))).mode & 0o777,
      0o700,
    );
  });

  it('prepends the Include while preserving CRLF contents and existing permissions', async () => {
    const original =
      '# Existing hosts\r\nHost example\r\n  HostName example.com\r\n';
    await fs.writeFile(userConfig, original, {mode: 0o640});
    await ensureUserConfigIncluded(userConfig, target);
    assert.strictEqual(
      await fs.readFile(userConfig, 'utf8'),
      `Include "${target}"\r\n${original}`,
    );
    assert.strictEqual((await fs.stat(userConfig)).mode & 0o777, 0o640);
  });

  it('does not rewrite a config that already globally includes the managed file', async () => {
    const original = `# Managed configs\nInclude "${path.dirname(target)}/*"\nHost example\n  HostName example.com\n`;
    await fs.writeFile(userConfig, original);
    await fs.utimes(userConfig, new Date(0), new Date(0));
    await ensureUserConfigIncluded(userConfig, target);
    assert.strictEqual(await fs.readFile(userConfig, 'utf8'), original);
    assert.strictEqual((await fs.stat(userConfig)).mtimeMs, 0);
  });

  it('adds a global Include ahead of a scoped one and remains idempotent', async () => {
    const original = `Host example\n  Include "${target}"\n`;
    await fs.writeFile(userConfig, original);
    await ensureUserConfigIncluded(userConfig, target);
    const expected = `Include "${target}"\n${original}`;
    assert.strictEqual(await fs.readFile(userConfig, 'utf8'), expected);
    await ensureUserConfigIncluded(userConfig, target);
    assert.strictEqual(await fs.readFile(userConfig, 'utf8'), expected);
  });

  it('updates a symlinked config without replacing the symlink', async () => {
    const actualConfig = path.join(tmp, 'actual-config');
    const original = 'Host example\n  HostName example.com\n';
    await fs.writeFile(actualConfig, original);
    await fs.symlink(actualConfig, userConfig);
    await ensureUserConfigIncluded(userConfig, target);
    assert.ok((await fs.lstat(userConfig)).isSymbolicLink());
    assert.strictEqual(
      await fs.readFile(actualConfig, 'utf8'),
      `Include "${target}"\n${original}`,
    );
  });

  it('does not include the managed file from itself, including through a symlink', async () => {
    const original = 'Host apple-container.test\n  HostName test\n';
    await fs.mkdir(path.dirname(target));
    await fs.writeFile(target, original);
    await ensureUserConfigIncluded(target, target);
    assert.strictEqual(await fs.readFile(target, 'utf8'), original);
    await fs.symlink(target, userConfig);
    await ensureUserConfigIncluded(userConfig, target);
    assert.strictEqual(await fs.readFile(target, 'utf8'), original);
  });

  it('propagates read errors without replacing the existing config path', async () => {
    await fs.mkdir(userConfig);
    const marker = path.join(userConfig, 'keep');
    await fs.writeFile(marker, 'untouched');
    await assert.rejects(ensureUserConfigIncluded(userConfig, target), {
      code: 'EISDIR',
    });
    assert.strictEqual(await fs.readFile(marker, 'utf8'), 'untouched');
  });
});

/** A container target whose CLI records what it is asked to run */
function fakeContainer(id: string, outputs: string[] = []) {
  const runs: {args: string[]; input?: string}[] = [];
  const cli = {
    executable: async () => '/opt/homebrew/bin/container',
    run: async (args: string[], options?: {input?: string}) => {
      runs.push({args, input: options?.input});
      return outputs.shift() ?? '';
    },
  } as unknown as ContainerCli;
  return {target: containerTarget(cli, id), runs};
}

describe('package installs in the container', () => {
  it('runs the package manager as root and maps its exit code', async () => {
    const calls: InstallCommand[] = [];
    const runner =
      (code: number | undefined) => async (command: InstallCommand) => {
        calls.push(command);
        return code;
      };
    const {target} = fakeContainer('dev');

    await installPackages(target, ['wget', 'ca-certificates'], runner(0));
    assert.strictEqual(calls[0].executable, '/opt/homebrew/bin/container');
    assert.deepStrictEqual(calls[0].packages, ['wget', 'ca-certificates']);
    assert.deepStrictEqual(calls[0].args.slice(0, 6), [
      'exec',
      '-u',
      '0',
      'dev',
      'sh',
      '-c',
    ]);
    assert.deepStrictEqual(calls[0].args.slice(7), [
      'sh',
      'wget',
      'ca-certificates',
    ]);

    // Cancelling stops the install script inside the container, as root
    assert.deepStrictEqual(calls[0].cancelArgs.slice(0, 6), [
      'exec',
      '-u',
      '0',
      'dev',
      'sh',
      '-c',
    ]);

    await assert.rejects(
      installPackages(target, ['bash'], runner(5)),
      NoPackageManagerError,
    );
    await assert.rejects(
      installPackages(target, ['bash'], runner(100)),
      (error: unknown) =>
        error instanceof InstallFailedError && error.exitCode === 100,
    );
    // A task that ended without an exit code (e.g. terminated) is a failure too
    await assert.rejects(
      installPackages(target, ['bash'], runner(undefined)),
      InstallFailedError,
    );
  });

  it('prepares a container as root with the key on stdin', async () => {
    const {target, runs} = fakeContainer('dev', [
      'sshd=/usr/sbin/sshd\nuser=ubuntu\nhome=/home/ubuntu\n',
    ]);
    const result = await prepareTarget(target, '1000', 'ssh-ed25519 AAAA k');
    assert.strictEqual(result.user, 'ubuntu');
    assert.deepStrictEqual(runs[0].args.slice(0, 5), [
      'exec',
      '-i',
      '-u',
      '0',
      'dev',
    ]);
    assert.strictEqual(runs[0].args.at(-1), '1000');
    assert.strictEqual(runs[0].input, 'ssh-ed25519 AAAA k\n');
  });
});

describe('pods over Remote-SSH', () => {
  const kube = {
    kubeconfig: '/Users/dev/Library/Application Support/Code/kube/dev.yaml',
    context: 'dev',
  };
  const ref = {
    cluster: 'dev',
    namespace: 'web',
    pod: 'Api-0',
    container: 'app',
  };

  it('names pod hosts briefly, adding what tells them apart only when needed', () => {
    assert.strictEqual(podHostAlias(ref), 'pod.api-0');
    assert.strictEqual(
      podHostAlias(ref, {multiContainer: true}),
      'pod.api-0.app',
    );
    // The same pod name in another namespace or cluster already has the short host
    assert.strictEqual(
      podHostAlias(ref, {taken: alias => alias === 'pod.api-0'}),
      'pod.api-0.web.dev',
    );
  });

  it('runs commands with kubectl exec in the pod container, without switching users', () => {
    const target = podTarget(
      '/opt/homebrew/bin/kubectl',
      kube,
      ref,
      'pod.api-0',
    );
    assert.strictEqual(target.name, 'web/Api-0');
    assert.strictEqual(target.alias, 'pod.api-0');
    assert.strictEqual(target.switchesUser, false);
    assert.deepStrictEqual(target.exec(['env'], {stdin: true, root: true}), [
      '--kubeconfig',
      kube.kubeconfig,
      '--context',
      'dev',
      'exec',
      '-i',
      '--namespace',
      'web',
      'Api-0',
      '--container',
      'app',
      '--',
      'env',
    ]);
  });

  it('quotes the kubeconfig path in the ProxyCommand', () => {
    const target = podTarget(
      '/opt/homebrew/bin/kubectl',
      kube,
      ref,
      'pod.api-0',
    );
    const command = proxyCommand(
      '/opt/homebrew/bin/kubectl',
      target.exec,
      '/usr/sbin/sshd',
      POD_SSHD_ARGS,
    );
    assert.ok(
      command.startsWith(
        '"/opt/homebrew/bin/kubectl" --kubeconfig "/Users/dev/Library/Application Support/Code/kube/dev.yaml" --context dev exec -i --namespace web Api-0 --container app -- /usr/sbin/sshd -i -E /dev/null -o ',
      ),
      command,
    );
    const text = renderConfig([], '/x/container', '/k', [
      {
        alias: target.alias,
        hostName: 'Api-0.web',
        user: 'root',
        proxyCommand: command,
      },
    ]);
    assert.match(text, /^Host pod\.api-0$/m);
    assert.match(text, /^ {2}ProxyCommand "\/opt\/homebrew\/bin\/kubectl" /m);
  });

  it('runs a prelude in its own shell before the ProxyCommand', () => {
    const command = withPrelude(
      '/opt/homebrew/bin/container',
      ['cluster', 'write-config', '--name', 'dev', '--kubeconfig', "/a b/it's"],
      '"/k" exec -i x',
    );
    assert.strictEqual(
      command,
      `/bin/sh -c '"/opt/homebrew/bin/container" cluster write-config --name dev --kubeconfig "/a b/it'\\''s" >/dev/null 2>&1; exec "/k" exec -i x'`,
    );
  });

  it('refuses a pod that does not run as root', async () => {
    const runs: string[][] = [];
    const target = {
      ...podTarget('/k', kube, ref, 'pod.api-0'),
      run: async (args: string[]) => {
        runs.push(args);
        return '1000\n';
      },
    };
    await assert.rejects(
      prepareTarget(target, 'root', 'key'),
      (error: unknown) =>
        error instanceof PodNotRootError && error.uid === '1000',
    );
    // Only the uid check ran
    assert.strictEqual(runs.length, 1);
    assert.deepStrictEqual(runs[0].slice(-3), ['--', 'id', '-u']);
  });
});
