import * as path from 'path';

import Mocha from 'mocha';

// Entry point loaded by the VS Code extension host
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 180_000, grep: process.env.E2E_GREP });
  mocha.addFile(path.join(__dirname, 'extension.e2e.test.js'));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} e2e tests failed`)) : resolve()));
  });
}
