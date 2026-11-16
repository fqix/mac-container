import * as assert from 'assert';

import {mkdtemp, readFile, rm, writeFile} from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {CliError, ContainerCli} from '../../src/services/cli';
import {
  ClusterKubeconfigs,
  clusterCreateArgs,
  clusterEnv,
  clusterShimPath,
  expandHome,
  isClusterUnsupported,
  isValidClusterName,
  resolveKubeconfig,
} from '../../src/services/cluster';

describe('cluster', () => {
  const home = '/Users/dev';
  const none = () => false;

  it('resolves the kubeconfig the way the CLI does', () => {
    assert.strictEqual(
      resolveKubeconfig('', undefined, home, none),
      '/Users/dev/.kube/config',
    );
    assert.strictEqual(
      resolveKubeconfig('', '', home, none),
      '/Users/dev/.kube/config',
    );
    assert.strictEqual(resolveKubeconfig('', '/a', home, none), '/a');
    // Of several, the first existing one, else the last
    assert.strictEqual(
      resolveKubeconfig('', '/a:/b:/c', home, f => f === '/b' || f === '/c'),
      '/b',
    );
    assert.strictEqual(resolveKubeconfig('', '/a:/b', home, none), '/b');
  });

  it('prefers the setting and expands ~', () => {
    assert.strictEqual(
      resolveKubeconfig(' ~/.kube/dev ', '/a', home, none),
      '/Users/dev/.kube/dev',
    );
    assert.deepStrictEqual(clusterEnv('~/k', home), {
      KUBECONFIG: '/Users/dev/k',
    });
    assert.strictEqual(clusterEnv('  ', home), undefined);
    assert.strictEqual(expandHome('/x/~', home), '/x/~');
  });

  it('builds the create arguments', () => {
    assert.deepStrictEqual(
      clusterCreateArgs({name: 'dev', workers: 0, sharedImageStore: false}),
      ['cluster', 'create', '--name', 'dev'],
    );
    assert.deepStrictEqual(
      clusterCreateArgs({name: 'dev', workers: 2, sharedImageStore: true}),
      [
        'cluster',
        'create',
        '--name',
        'dev',
        '--workers',
        '2',
        '--shared-image-store',
      ],
    );
  });

  it('locates cluster-shim under the install root', () => {
    assert.strictEqual(
      clusterShimPath('/opt/homebrew/Cellar/container/1.7.1_2/'),
      '/opt/homebrew/Cellar/container/1.7.1_2/libexec/container/plugins/cluster/resources/cluster-shim',
    );
  });

  it('accepts DNS label names only', () => {
    assert.ok(isValidClusterName('cluster-dev'));
    assert.ok(isValidClusterName('a'));
    for (const name of ['', 'Dev', '-dev', 'dev-', 'a_b', 'a.b']) {
      assert.ok(!isValidClusterName(name), name);
    }
  });

  it('detects a CLI without the cluster subcommand', () => {
    const error = (stderr: string) =>
      new CliError(['cluster', 'list'], 64, stderr);
    assert.ok(isClusterUnsupported(error("Error: unknown command 'cluster'")));
    assert.ok(!isClusterUnsupported(error('Error: XPC connection error')));
    assert.ok(!isClusterUnsupported(new Error("unknown command 'cluster'")));
  });

  it('writes one kubeconfig per cluster once, again after invalidate', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kubeconfigs-test-'));
    const calls: string[][] = [];
    const cli = {
      run: async (args: string[]) => {
        calls.push(args);
        await writeFile(args[args.length - 1], 'apiVersion: v1\n');
        return '';
      },
    } as unknown as ContainerCli;
    try {
      const kubeconfigs = new ClusterKubeconfigs(cli, dir);
      const target = await kubeconfigs.target('dev');
      assert.deepStrictEqual(target, {
        kubeconfig: path.join(dir, 'dev.yaml'),
        context: 'dev',
      });
      await kubeconfigs.target('dev');
      assert.deepStrictEqual(calls, [
        [
          'cluster',
          'write-config',
          '--name',
          'dev',
          '--kubeconfig',
          path.join(dir, 'dev.yaml'),
        ],
      ]);
      kubeconfigs.invalidate('dev');
      await kubeconfigs.target('dev');
      assert.strictEqual(calls.length, 2);
      await kubeconfigs.remove('dev');
      await assert.rejects(readFile(path.join(dir, 'dev.yaml')));
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('retries a kubeconfig that could not be written', async () => {
    let attempts = 0;
    const cli = {
      run: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('not running');
        }
        return '';
      },
    } as unknown as ContainerCli;
    const kubeconfigs = new ClusterKubeconfigs(cli, '/nonexistent');
    await assert.rejects(kubeconfigs.target('dev'));
    await kubeconfigs.target('dev');
    assert.strictEqual(attempts, 2);
  });
});
