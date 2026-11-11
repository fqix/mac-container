import * as assert from 'assert';

import {formatElapsed, toTerminalText} from '../../src/utils/steps';

describe('step terminal text', () => {
  it('formats elapsed time for step lines', () => {
    assert.strictEqual(formatElapsed(850), '850ms');
    assert.strictEqual(formatElapsed(35_000), '35s');
    assert.strictEqual(formatElapsed(220_000), '3m40s');
    assert.strictEqual(formatElapsed(65_000), '1m05s');
    assert.strictEqual(formatElapsed(3_720_000), '1h02m');
  });

  it('turns line feeds into CRLF without doubling existing ones', () => {
    assert.strictEqual(toTerminalText('a\nb\r\nc'), 'a\r\nb\r\nc');
    // apt redraws progress with a bare carriage return, which must stay as it is
    assert.strictEqual(toTerminalText('50%\r60%\n'), '50%\r60%\r\n');
  });
});
