import * as assert from 'assert';

import { generateContainerName } from '../../src/names';

describe('container names', () => {
  it('generates adjective_surname names', () => {
    for (let i = 0; i < 50; i++) {
      assert.match(generateContainerName(new Set()), /^[a-z]+_[a-z]+$/);
    }
  });

  it('avoids names that are taken, appending a number when it keeps colliding', () => {
    const fixed = () => 0;
    const first = generateContainerName(new Set(), fixed);
    assert.strictEqual(first, 'agile_babbage');
    assert.strictEqual(generateContainerName(new Set([first]), fixed), 'agile_babbage1');
    assert.strictEqual(generateContainerName(new Set([first, 'agile_babbage1']), fixed), 'agile_babbage2');
  });
});
