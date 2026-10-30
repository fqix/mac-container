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
  // Build context for the image build test: a target stage, a build argument and a secret
  fs.writeFileSync(
    path.join(workspace, 'Dockerfile'),
    [
      'FROM docker.io/library/alpine:latest AS base',
      'ARG GREETING=default',
      'RUN --mount=type=secret,id=token cp /run/secrets/token /secret.txt && echo "$GREETING" > /greeting.txt',
      'FROM base AS final',
      'RUN echo final > /final.txt',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(tmp, 'token'), 'e2e-secret');
  // Compose project for the compose up / down test; the unique name keeps it apart from real projects
  fs.writeFileSync(
    path.join(workspace, 'compose.yml'),
    `name: e2e-compose-${Date.now().toString(36)}\nservices:\n  app:\n    image: docker.io/library/alpine:latest\n    command: ["sleep", "3600"]\n`,
  );

  // Remote-SSH: keep the generated key and host config out of the real ~/.ssh, and point Remote-SSH at a scratch user config
  const sshDir = path.join(tmp, 'ssh');
  const userSshConfig = path.join(tmp, 'ssh_config');
  fs.mkdirSync(path.join(tmp, 'user-data', 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'user-data', 'User', 'settings.json'),
    JSON.stringify({ 'remote.SSH.configFile': userSshConfig }),
  );

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'e2e', 'index.js'),
      extensionTestsEnv: { APPLE_CONTAINER_SSH_DIR: sshDir, E2E_USER_SSH_CONFIG: userSshConfig },
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${path.join(tmp, 'user-data')}`,
        `--extensions-dir=${path.join(tmp, 'extensions')}`,
      ],
    });
    // Same extension, no folder argument: commands such as pull must not depend on a workspace folder
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'e2e', 'index.js'),
      extensionTestsEnv: { E2E_SUITE: 'emptyWindow' },
      launchArgs: [
        '--disable-extensions',
        // Keep it short: VS Code puts its IPC socket here and macOS limits socket paths to 104 bytes
        `--user-data-dir=${path.join(tmp, 'ud-empty')}`,
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
