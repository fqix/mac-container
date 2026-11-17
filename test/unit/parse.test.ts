import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  formatBytes,
  formatRelativeTime,
  groupImagesByRepository,
  parseClusters,
  parseContainers,
  parseDiskUsage,
  parseImages,
  parseJson,
  parseNetworks,
  parseRegistries,
  parseSystemStatus,
  parseVolumes,
  shortImageName,
  splitImageName,
} from '../../src/utils/parse';

// Compiled to out/test/unit, fixtures stay in the source tree
const fixture = (name: string) =>
  parseJson(
    fs.readFileSync(
      path.resolve(__dirname, '../../../test/fixtures', name),
      'utf8',
    ),
  );

describe('parse', () => {
  it('parses containers', () => {
    const items = parseContainers(fixture('containers.json'));
    const running = items.find(c => c.id === 'ccdev-test')!;
    assert.strictEqual(running.state, 'running');
    assert.strictEqual(running.image, 'docker.io/library/alpine:latest');
    assert.strictEqual(running.command, 'sleep 600');
    assert.match(running.ipv4 ?? '', /^\d+\.\d+\.\d+\.\d+$/);
    assert.deepStrictEqual(running.networks, ['default']);
    assert.strictEqual(running.platform, 'linux/arm64/v8');
    assert.strictEqual(running.cpus, 4);

    const stopped = items.find(c => c.id === 'ccdev-stopped')!;
    assert.strictEqual(stopped.state, 'stopped');
    assert.strictEqual(stopped.ipv4, undefined);

    const ports = items.find(c => c.id === 'ccdev-ports')!;
    assert.deepStrictEqual(ports.ports, [
      '18080->80/tcp',
      '127.0.0.1:18443->443/tcp',
    ]);
    assert.ok(items.every(c => !c.builder));
  });

  it('flags the BuildKit builder container by its role label', () => {
    const [builder, other] = parseContainers([
      {
        id: 'buildkit',
        configuration: {
          labels: {
            'com.apple.container.plugin': 'builder',
            'com.apple.container.resource.role': 'builder',
          },
        },
      },
      {
        id: 'web',
        configuration: {
          labels: {'com.apple.container.resource.role': 'builtin'},
        },
      },
    ]);
    assert.strictEqual(builder.builder, true);
    assert.strictEqual(other.builder, false);
  });

  it('parses images', () => {
    const images = parseImages(fixture('images.json'));
    const alpine = images.find(i => i.displayName === 'alpine:latest')!;
    assert.strictEqual(alpine.reference, 'docker.io/library/alpine:latest');
    assert.ok(alpine.digest.startsWith('sha256:'));
    assert.ok(alpine.sizeBytes > 0);
    assert.ok(alpine.platforms.includes('linux/arm64/v8'));
    assert.ok(alpine.createdAt && Date.parse(alpine.createdAt) > 0);
  });

  it('falls back from an epoch image creation date to the arm64 variant', () => {
    const variant = (architecture: string, created: string) => ({
      platform: {os: 'linux', architecture},
      size: 1,
      config: {
        created: '1970-01-01T00:00:00Z',
        config: {Labels: {'org.opencontainers.image.created': created}},
        history: [{created}],
      },
    });
    const [image] = parseImages([
      {
        id: 'd66b',
        configuration: {
          name: 'docker.io/library/ubuntu:latest',
          creationDate: '1970-01-01T00:00:00Z',
        },
        variants: [
          variant('amd64', '2026-11-06T10:28:50+00:00'),
          {platform: {os: 'unknown', architecture: 'unknown'}, config: {}},
          variant('arm64', '2026-11-06T10:31:00+00:00'),
        ],
      },
    ]);
    assert.strictEqual(image.createdAt, '2026-11-06T10:31:00+00:00');

    const [unknown] = parseImages([
      {
        id: 'x',
        configuration: {name: 'x', creationDate: '1970-01-01T00:00:00Z'},
        variants: [],
      },
    ]);
    assert.strictEqual(unknown.createdAt, undefined);
  });

  it('splits image names into repository and tag', () => {
    assert.deepStrictEqual(splitImageName('ubuntu:22.04'), {
      repository: 'ubuntu',
      tag: '22.04',
    });
    assert.deepStrictEqual(splitImageName('localhost:5000/app:v1'), {
      repository: 'localhost:5000/app',
      tag: 'v1',
    });
    assert.deepStrictEqual(splitImageName('localhost:5000/app'), {
      repository: 'localhost:5000/app',
      tag: 'latest',
    });
    assert.deepStrictEqual(
      splitImageName(
        'kindest/node@sha256:ce977ae6d65918d0b58a5f8b5e940429c2ce42fa3a5619ec2bbc60b949c0ac95',
      ),
      {repository: 'kindest/node', tag: '@sha256:ce977ae6d659'},
    );
    assert.deepStrictEqual(
      splitImageName('localhost:5000/app:v1@sha256:0123456789abcdef'),
      {repository: 'localhost:5000/app', tag: '@sha256:0123456789ab'},
    );
  });

  it('groups images by repository', () => {
    const image = (displayName: string) => ({
      reference: `docker.io/library/${displayName}`,
      displayName,
      digest: '',
      sizeBytes: 0,
      platforms: [],
    });
    const groups = groupImagesByRepository([
      image('ubuntu:latest'),
      image('alpine:latest'),
      image('ubuntu:22.04'),
    ]);
    assert.deepStrictEqual(
      groups.map(g => [g.name, g.images.map(i => i.displayName)]),
      [
        ['alpine', ['alpine:latest']],
        ['ubuntu', ['ubuntu:22.04', 'ubuntu:latest']],
      ],
    );
  });

  it('parses networks and flags the built-in one', () => {
    const [network] = parseNetworks(fixture('networks.json'));
    assert.strictEqual(network.id, 'default');
    assert.strictEqual(network.builtin, true);
    assert.strictEqual(network.mode, 'nat');
    assert.strictEqual(network.ipv4Subnet, '192.168.64.0/24');
  });

  it('parses volumes', () => {
    const [volume] = parseVolumes(fixture('volumes.json'));
    assert.strictEqual(volume.name, 'ccdev-vol');
    assert.strictEqual(volume.format, 'ext4');
    assert.ok((volume.sizeBytes ?? 0) > 0);
  });

  it('parses system status', () => {
    const status = parseSystemStatus(fixture('status.json'));
    assert.strictEqual(status.running, true);
    assert.strictEqual(status.serverVersion, '1.6.1');
    assert.strictEqual(typeof status.containersRunning, 'number');
    assert.strictEqual(parseSystemStatus({status: 'stopped'}).running, false);
    assert.strictEqual(status.hostCpus, 10);
    assert.strictEqual(
      status.installRoot,
      '/opt/homebrew/Cellar/container/1.6.1/',
    );
  });

  it('parses clusters', () => {
    const [cluster] = parseClusters(fixture('clusters.json'));
    assert.strictEqual(cluster.name, 'e2e-cluster');
    assert.strictEqual(cluster.state, 'running');
    assert.strictEqual(cluster.kubernetesVersion, 'v1.35.5');
    assert.strictEqual(cluster.sharedImageStore, false);
    assert.strictEqual(cluster.cni, undefined);
    assert.deepStrictEqual(cluster.nodes, [
      {
        name: 'e2e-cluster',
        roles: ['control-plane'],
        status: 'running',
        addresses: ['192.168.64.9'],
        ports: ['6446->6443'],
      },
      {
        name: 'e2e-cluster-worker-1',
        roles: ['worker'],
        status: 'running',
        addresses: ['192.168.64.10'],
        ports: [],
      },
    ]);
    // A configured node the status does not list yet has no status
    const [pending] = parseClusters([
      {
        id: 'c',
        configuration: {
          name: 'c',
          nodes: [{name: 'c', roles: ['control-plane']}],
        },
        status: {state: 'creating'},
      },
    ]);
    assert.deepStrictEqual(pending.nodes[0], {
      name: 'c',
      roles: ['control-plane'],
      status: undefined,
      addresses: [],
      ports: [],
    });
  });

  it('parses disk usage', () => {
    const usage = parseDiskUsage(fixture('df.json'));
    assert.deepStrictEqual(usage.images, {
      total: 3,
      active: 1,
      sizeBytes: 329625600,
      reclaimableBytes: 282136576,
    });
    assert.strictEqual(usage.volumes.sizeBytes, 39882752);
    // Missing sections and bad numbers read as zero
    assert.deepStrictEqual(parseDiskUsage({images: {total: 'x'}}).images, {
      total: 0,
      active: 0,
      sizeBytes: 0,
      reclaimableBytes: 0,
    });
  });

  it('treats empty output and non-arrays as empty lists', () => {
    assert.deepStrictEqual(parseContainers(parseJson('')), []);
    assert.deepStrictEqual(parseImages({}), []);
  });
});

describe('format', () => {
  it('shortens Docker Hub references only', () => {
    assert.strictEqual(
      shortImageName('docker.io/library/alpine:latest'),
      'alpine:latest',
    );
    assert.strictEqual(
      shortImageName('docker.io/bitnami/redis:7'),
      'bitnami/redis:7',
    );
    assert.strictEqual(
      shortImageName('ghcr.io/org/app:1.0'),
      'ghcr.io/org/app:1.0',
    );
  });

  it('formats bytes', () => {
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1536), '1.5 KB');
    assert.strictEqual(formatBytes(1073741824), '1.0 GB');
    assert.strictEqual(formatBytes(undefined), '');
  });

  it('formats relative time in the given locale', () => {
    const now = new Date('2026-10-28T08:10:00Z');
    assert.strictEqual(
      formatRelativeTime('2026-10-28T08:05:00Z', 'en', now),
      '5 minutes ago',
    );
    assert.strictEqual(
      formatRelativeTime('2026-10-28T08:05:00Z', 'zh-cn', now),
      '5分钟前',
    );
    assert.strictEqual(
      formatRelativeTime('2026-10-26T08:10:00Z', 'en', now),
      '2 days ago',
    );
    assert.strictEqual(formatRelativeTime(undefined, 'en', now), '');
    assert.strictEqual(formatRelativeTime('not a date', 'en', now), '');
  });
});

describe('registries', () => {
  it('parses registry logins (flat RegistryResource JSON)', () => {
    const [registry] = parseRegistries([
      {
        id: 'ghcr.io',
        name: 'ghcr.io',
        username: 'octocat',
        creationDate: '2026-10-01T00:00:00Z',
        modificationDate: '2026-10-02T00:00:00Z',
        labels: {},
      },
    ]);
    assert.deepStrictEqual(registry, {
      hostname: 'ghcr.io',
      username: 'octocat',
      createdAt: '2026-10-01T00:00:00Z',
      modifiedAt: '2026-10-02T00:00:00Z',
    });
  });

  it('converts Foundation reference dates', () => {
    // 1_700_000_000 Unix seconds == 721_692_800 seconds since 2001-01-01
    const [registry] = parseRegistries([
      {name: 'docker.io', username: 'u', creationDate: 721_692_800},
    ]);
    assert.strictEqual(
      registry.createdAt,
      new Date(1_700_000_000_000).toISOString(),
    );
  });
});
