import * as assert from 'assert';
import {mkdir, mkdtemp, rm} from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  downloadedKubectlPath,
  downloadedKubectlVersions,
  KubectlError,
  kubectlArgs,
  kubectlDownloadUrl,
  parseSha256,
} from '../../src/services/kubectl';

describe('kubectl', () => {
  it('targets the cluster through its own kubeconfig and context', () => {
    assert.deepStrictEqual(
      kubectlArgs({kubeconfig: '/k/dev.yaml', context: 'dev'}, ['get', 'pods']),
      ['--kubeconfig', '/k/dev.yaml', '--context', 'dev', 'get', 'pods'],
    );
  });

  it('downloads the darwin/arm64 build of a release only', () => {
    assert.strictEqual(
      kubectlDownloadUrl('v1.35.5'),
      'https://dl.k8s.io/release/v1.35.5/bin/darwin/arm64/kubectl',
    );
    for (const bad of ['1.35.5', 'v1.35', 'v1.35.5/../../x', 'latest']) {
      assert.throws(() => kubectlDownloadUrl(bad), bad);
    }
  });

  it('reads the published checksum', () => {
    const hex = 'a'.repeat(64);
    assert.strictEqual(parseSha256(`${hex}\n`), hex);
    assert.strictEqual(parseSha256(`${hex.toUpperCase()}  kubectl`), hex);
    assert.throws(() => parseSha256('<html>not found</html>'));
  });

  it('lists downloaded versions newest first', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kubectl-test-'));
    try {
      for (const v of ['v1.9.0', 'v1.35.5', 'v1.35.10', 'tmp']) {
        await mkdir(path.join(dir, v));
      }
      assert.deepStrictEqual(await downloadedKubectlVersions(dir), [
        'v1.35.10',
        'v1.35.5',
        'v1.9.0',
      ]);
      assert.strictEqual(
        downloadedKubectlPath(dir, 'v1.35.5'),
        path.join(dir, 'v1.35.5', 'kubectl'),
      );
      assert.deepStrictEqual(
        await downloadedKubectlVersions(path.join(dir, 'missing')),
        [],
      );
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('reports the first error line of kubectl', () => {
    const error = new KubectlError(
      ['get', 'pods'],
      'error: the server doesn\'t have a resource type "podz"\n',
    );
    assert.strictEqual(
      error.message,
      'kubectl get pods: the server doesn\'t have a resource type "podz"',
    );
  });
});
