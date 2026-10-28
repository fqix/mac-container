import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CliError, CliNotFoundError, cliErrorDetail, ContainerCli, resolveCliPath } from '../../src/services/cli';

describe('cli', () => {
  let dir: string;
  let fake: string;

  before(() => {
    // A fake CLI that echoes canned output, so tests do not need the real container service
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-container-test-'));
    fake = path.join(dir, 'container');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "list --all") echo \'[{"id":"web","configuration":{"id":"web"},"status":{"state":"running"}}]\' ;;',
        '  "system status") echo "Error: apiserver is not running" >&2; exit 1 ;;',
        '  *) echo "Error: unknown command $*" >&2; exit 2 ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 },
    );
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resolves the CLI from PATH', async () => {
    assert.strictEqual(await resolveCliPath('container', dir), fake);
    assert.strictEqual(await resolveCliPath(fake, ''), fake);
    assert.strictEqual(await resolveCliPath('/nonexistent/container', ''), undefined);
  });

  it('runs commands and parses JSON', async () => {
    const cli = new ContainerCli(() => fake);
    const containers = await cli.listContainers();
    assert.strictEqual(containers.length, 1);
    assert.strictEqual(containers[0].id, 'web');
  });

  it('reports a stopped service instead of throwing', async () => {
    const cli = new ContainerCli(() => fake);
    assert.deepStrictEqual(await cli.systemStatus(), { running: false });
  });

  it('wraps CLI failures with stderr', async () => {
    const cli = new ContainerCli(() => fake);
    await assert.rejects(cli.run(['bogus']), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.strictEqual(error.exitCode, 2);
      assert.strictEqual(cliErrorDetail(error.stderr, error.exitCode), 'unknown command bogus');
      return true;
    });
  });

  it('throws CliNotFoundError for a missing executable', async () => {
    const cli = new ContainerCli(() => '/nonexistent/container');
    await assert.rejects(cli.listContainers(), CliNotFoundError);
  });
});

describe('cli stdin', () => {
  it('passes input on stdin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-container-test-'));
    const fake = path.join(dir, 'container');
    fs.writeFileSync(fake, '#!/bin/sh\necho "args=$* stdin=$(cat)"\n', { mode: 0o755 });
    try {
      const out = await new ContainerCli(() => fake).run(['registry', 'login', '--password-stdin', 'ghcr.io'], { input: 's3cret' });
      assert.strictEqual(out.trim(), 'args=registry login --password-stdin ghcr.io stdin=s3cret');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
