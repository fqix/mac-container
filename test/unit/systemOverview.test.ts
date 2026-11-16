import * as assert from 'assert';

import {percentOf} from '../../src/services/systemOverview';

describe('systemOverview', () => {
  it('computes a clamped percentage', () => {
    assert.strictEqual(percentOf(1, 4), 25);
    assert.strictEqual(percentOf(5, 0), 0);
    assert.strictEqual(percentOf(8, 4), 100);
    assert.strictEqual(percentOf(-1, 4), 0);
  });
});
