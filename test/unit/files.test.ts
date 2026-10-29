import * as assert from 'assert';

import { joinContainerPath, parentContainerPath, parseListing, uniqueLocalPath } from '../../src/utils/files';
import { parseContainers } from '../../src/utils/parse';

describe('container files', () => {
  it('parses ls -1Ap output with directories first', () => {
    assert.deepStrictEqual(parseListing('./\n../\nb.txt\netc/\na b/\n.profile\n'), [
      { name: 'a b', directory: true },
      { name: 'etc', directory: true },
      { name: '.profile', directory: false },
      { name: 'b.txt', directory: false },
    ]);
  });

  it('joins container paths POSIX style', () => {
    assert.strictEqual(joinContainerPath('/', 'etc'), '/etc');
    assert.strictEqual(joinContainerPath('/home/dev/', 'a b'), '/home/dev/a b');
    assert.strictEqual(parentContainerPath('/home/dev'), '/home');
    assert.strictEqual(parentContainerPath('/'), '/');
  });

  it('never overwrites a local file when downloading', () => {
    const taken = new Set(['/d/app.log', '/d/app (1).log', '/d/src', '/d/.env']);
    const exists = (f: string) => taken.has(f);
    assert.strictEqual(uniqueLocalPath('/d', 'new.txt', exists), '/d/new.txt');
    assert.strictEqual(uniqueLocalPath('/d', 'app.log', exists), '/d/app (2).log');
    assert.strictEqual(uniqueLocalPath('/d', 'src', exists), '/d/src (1)');
    assert.strictEqual(uniqueLocalPath('/d', '.env', exists), '/d/.env (1)');
  });

  it('reads the container working directory', () => {
    const [c] = parseContainers([{ id: 'c', configuration: { initProcess: { workingDirectory: '/app' } } }]);
    assert.strictEqual(c.workdir, '/app');
  });
});
