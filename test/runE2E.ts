// Launches the locally installed VS Code with the extension under development and runs the e2e suite.
// Requires an Apple silicon Mac with the container service running.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const vscodeExecutablePath =
    process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-container-e2e-'));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace);
  // Minimal build context for the image build test
  fs.writeFileSync(path.join(workspace, 'Dockerfile'), 'FROM docker.io/library/alpine:latest\nRUN echo e2e > /e2e.txt\n');
  // Compose project for the compose up / down test; the unique name keeps it apart from real projects
  fs.writeFileSync(
    path.join(workspace, 'compose.yml'),
    `name: e2e-compose-${Date.now().toString(36)}\nservices:\n  app:\n    image: docker.io/library/alpine:latest\n    command: ["sleep", "3600"]\n`,
  );

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'e2e', 'index.js'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${path.join(tmp, 'user-data')}`,
        `--extensions-dir=${path.join(tmp, 'extensions')}`,
      ],
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
