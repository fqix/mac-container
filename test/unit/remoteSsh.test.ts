import * as assert from 'assert';

import { parseContainers } from '../../src/utils/parse';
import { hostAlias, isIncluded, parsePrepareOutput, renderConfig } from '../../src/services/remoteSsh';

describe('remote ssh', () => {
  const home = '/Users/dev';
  const target = '/Users/dev/.ssh/apple-container/config';

  it('builds lowercase host aliases', () => {
    assert.strictEqual(hostAlias('My-App'), 'apple-container.my-app');
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
  });

  it('ignores unrelated or commented Include lines', () => {
    assert.ok(!isIncluded('', home, target));
    assert.ok(!isIncluded('# Include ~/.ssh/apple-container/config', home, target));
    assert.ok(!isIncluded('Include ~/.ssh/config.d/*', home, target));
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
