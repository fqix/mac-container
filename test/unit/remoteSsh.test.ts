import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { parseContainers } from '../../src/utils/parse';
import { containerOfAuthority, ensureUserConfigIncluded, hostAlias, isIncluded, parsePrepareOutput, renderConfig } from '../../src/services/remoteSsh';

describe('remote ssh', () => {
  const home = '/Users/dev';
  const target = '/Users/dev/.ssh/apple-container/config';

  it('builds lowercase host aliases', () => {
    assert.strictEqual(hostAlias('My-App'), 'apple-container.my-app');
  });

  it('finds the container of a Remote-SSH window authority', () => {
    const ids = ['devc-app-1a2b', 'My-App'];
    assert.strictEqual(containerOfAuthority('ssh-remote+apple-container.devc-app-1a2b', ids), 'devc-app-1a2b');
    assert.strictEqual(containerOfAuthority('ssh-remote+apple-container.my-app', ids), 'My-App');
    assert.strictEqual(containerOfAuthority('ssh-remote+devbox', ids), undefined);
    assert.strictEqual(containerOfAuthority('dev-container+apple-container.my-app', ids), undefined);
  });

  it('renders one host block per container with a ProxyCommand through the CLI', () => {
    const text = renderConfig([{ id: 'web', sshd: '/usr/sbin/sshd', user: 'node' }], '/opt/homebrew/bin/container');
    assert.match(text, /^Host apple-container\.web$/m);
    assert.match(text, /^ {2}User node$/m);
    assert.match(text, /^ {2}ProxyCommand "\/opt\/homebrew\/bin\/container" exec -i -u 0 web \/usr\/sbin\/sshd -i /m);
  });

  it('detects Include directives in their common spellings', () => {
    assert.ok(isIncluded('Include ~/.ssh/apple-container/config\nHost *\n', home, target));
    assert.ok(isIncluded('  include apple-container/config', home, target));
    assert.ok(isIncluded('Include "/Users/dev/.ssh/apple-container/*"', home, target));
    assert.ok(isIncluded('Include ~/.ssh/other ~/.ssh/apple-container/config', home, target));
    assert.ok(isIncluded('Include=~/.ssh/apple-container/config # containers', home, target));
  });

  it('ignores unrelated or commented Include lines', () => {
    assert.ok(!isIncluded('', home, target));
    assert.ok(!isIncluded('# Include ~/.ssh/apple-container/config', home, target));
    assert.ok(!isIncluded('Include ~/.ssh/config.d/*', home, target));
    assert.ok(!isIncluded('Include ~/.ssh/other # ~/.ssh/apple-container/config', home, target));
  });

  it('does not treat an Include inside a Host or Match block as global', () => {
    assert.ok(!isIncluded('Host example\n  Include ~/.ssh/apple-container/config', home, target));
    assert.ok(!isIncluded('Match host example\n  Include ~/.ssh/apple-container/config', home, target));
    assert.ok(!isIncluded('Host=example\n  Include ~/.ssh/apple-container/config', home, target));
  });

  it('parses the prepare script output', () => {
    assert.deepStrictEqual(parsePrepareOutput('sshd=/usr/bin/sshd\nuser=dev\nhome=/home/dev\n'), {
      sshd: '/usr/bin/sshd',
      user: 'dev',
      home: '/home/dev',
    });
    assert.deepStrictEqual(parsePrepareOutput(''), { sshd: '/usr/sbin/sshd', user: 'root', home: '/' });
  });

  it('reads the container process user', () => {
    const user = (u: unknown) => parseContainers([{ id: 'c', configuration: { initProcess: { user: u } } }])[0].user;
    assert.strictEqual(user({ raw: { userString: 'node:staff' } }), 'node:staff');
    assert.strictEqual(user({ id: { uid: 1000, gid: 1000 } }), '1000');
    assert.strictEqual(user(undefined), undefined);
  });
});

describe('automatic SSH config inclusion', () => {
  let tmp: string;
  let userConfig: string;
  let target: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'apple-container-ssh-config-'));
    userConfig = path.join(tmp, 'config');
    target = path.join(tmp, 'managed hosts', 'config');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates a missing custom config and its parent directory with private permissions', async () => {
    userConfig = path.join(tmp, 'custom', 'config');
    await ensureUserConfigIncluded(userConfig, target);
    assert.strictEqual(await fs.readFile(userConfig, 'utf8'), `Include "${target}"\n`);
    assert.strictEqual((await fs.stat(userConfig)).mode & 0o777, 0o600);
    assert.strictEqual((await fs.stat(path.dirname(userConfig))).mode & 0o777, 0o700);
  });

  it('prepends the Include while preserving CRLF contents and existing permissions', async () => {
    const original = '# Existing hosts\r\nHost example\r\n  HostName example.com\r\n';
    await fs.writeFile(userConfig, original, { mode: 0o640 });
    await ensureUserConfigIncluded(userConfig, target);
    assert.strictEqual(await fs.readFile(userConfig, 'utf8'), `Include "${target}"\r\n${original}`);
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
    assert.strictEqual(await fs.readFile(actualConfig, 'utf8'), `Include "${target}"\n${original}`);
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
    await assert.rejects(ensureUserConfigIncluded(userConfig, target), { code: 'EISDIR' });
    assert.strictEqual(await fs.readFile(marker, 'utf8'), 'untouched');
  });
});
