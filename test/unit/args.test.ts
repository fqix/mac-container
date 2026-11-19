import * as assert from 'assert';

import {BUILD_OPTION_KEYS, type BuildOptions} from '../../src/services/build';
import {optionsArgument} from '../../src/utils/args';

describe('command arguments', () => {
  it('takes only an options object, not the explorer selection', () => {
    // What the explorer passes as the second argument: the selected URIs
    const selection = [{scheme: 'file', fsPath: '/app/Dockerfile'}];
    assert.strictEqual(
      optionsArgument<BuildOptions>(selection, BUILD_OPTION_KEYS),
      undefined,
    );
    assert.strictEqual(
      optionsArgument<BuildOptions>(undefined, BUILD_OPTION_KEYS),
      undefined,
    );
    assert.strictEqual(
      optionsArgument<BuildOptions>('tag', BUILD_OPTION_KEYS),
      undefined,
    );
    // An object without any known option is not options either
    assert.strictEqual(
      optionsArgument<BuildOptions>({fsPath: '/x'}, BUILD_OPTION_KEYS),
      undefined,
    );
    const direct = {tag: 'app:1', noCache: true};
    assert.strictEqual(
      optionsArgument<BuildOptions>(direct, BUILD_OPTION_KEYS),
      direct,
    );
    assert.deepStrictEqual(
      optionsArgument<{rebuild: boolean}>({rebuild: true}, ['rebuild']),
      {rebuild: true},
    );
  });
});
