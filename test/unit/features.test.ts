import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { composeProjectName, groupByComposeProject, isComposeFileName } from '../../src/services/compose';
import { parseContainers, parseJson } from '../../src/utils/parse';
import { buildRecreateArgs, formatPublishSpec, validateEdits } from '../../src/services/recreate';
import { toSample } from '../../src/services/stats';
import type { ContainerSummary } from '../../src/models/types';

const fixture = (name: string) =>
  parseJson(fs.readFileSync(path.resolve(__dirname, '../../../test/fixtures', name), 'utf8')) as any[];

describe('mounts and compose labels', () => {
  const [web] = parseContainers(fixture('compose-web.inspect.json'));

  it('parses named volumes and bind mounts', () => {
    assert.deepStrictEqual(web.mounts, [
      { kind: 'volume', source: 'ccdemo_data', destination: '/data', readOnly: false },
      { kind: 'bind', source: '/Users/dev/projects/ccdemo', destination: '/src', readOnly: false },
    ]);
  });

  it('parses published ports', () => {
    assert.deepStrictEqual(web.publishedPorts, [{ hostAddress: '0.0.0.0', hostPort: 18090, containerPort: 80, proto: 'tcp' }]);
  });

  it('reads container-compose labels', () => {
    assert.strictEqual(web.composeProject, 'ccdemo');
    assert.strictEqual(web.composeService, 'web');
  });
});

describe('compose', () => {
  const make = (id: string, project?: string, service?: string) =>
    ({ id, composeProject: project, composeService: service }) as ContainerSummary;

  it('groups containers by project and keeps the rest standalone', () => {
    const grouped = groupByComposeProject([
      make('b-web', 'b', 'web'),
      make('solo'),
      make('a-worker', 'a', 'worker'),
      make('a-api', 'a', 'api'),
    ]);
    assert.deepStrictEqual(
      grouped.projects.map((p) => [p.name, p.containers.map((c) => c.id)]),
      [
        ['a', ['a-api', 'a-worker']],
        ['b', ['b-web']],
      ],
    );
    assert.deepStrictEqual(grouped.standalone.map((c) => c.id), ['solo']);
  });

  it('derives the project name like container-compose', () => {
    assert.strictEqual(composeProjectName('services: {}\n', '/work/my.app/compose.yml'), 'my_app');
    assert.strictEqual(composeProjectName('name: shop\nservices: {}\n', '/work/x/compose.yml'), 'shop');
    assert.strictEqual(composeProjectName('name: "quoted" # comment\n', '/work/x/compose.yml'), 'quoted');
    // Nested name: keys do not count
    assert.strictEqual(composeProjectName('services:\n  web:\n    name: nope\n', '/work/dir/compose.yml'), 'dir');
  });

  it('recognizes compose file names', () => {
    for (const name of ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.dev.yml']) {
      assert.ok(isComposeFileName(name), name);
    }
    assert.ok(!isComposeFileName('values.yaml'));
  });
});

describe('recreate', () => {
  const [item] = fixture('compose-web.inspect.json');
  const config = item.configuration;

  it('rebuilds run arguments with edited ports and mounts', () => {
    const args = buildRecreateArgs(
      config,
      {
        ports: [{ hostAddress: '127.0.0.1', hostPort: 8080, containerPort: 80, proto: 'tcp' }],
        mounts: [
          { kind: 'volume', source: 'data', destination: '/data', readOnly: false },
          { kind: 'bind', source: '/Users/dev/src', destination: '/src', readOnly: true },
          { kind: 'tmpfs', source: '', destination: '/scratch', readOnly: false },
        ],
      },
      { start: true },
    );
    assert.deepStrictEqual(args.slice(0, 4), ['run', '--detach', '--name', 'ccdemo-web']);
    const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    assert.deepStrictEqual(pairs('--publish'), ['127.0.0.1:8080:80/tcp']);
    assert.deepStrictEqual(pairs('--volume'), ['data:/data', '/Users/dev/src:/src:ro']);
    assert.deepStrictEqual(pairs('--tmpfs'), ['/scratch']);
    assert.deepStrictEqual(pairs('--label').sort(), ['com.docker.compose.project=ccdemo', 'com.docker.compose.service=web']);
    assert.deepStrictEqual(pairs('--network'), ['default']);
    assert.deepStrictEqual(pairs('--cpus'), ['4']);
    assert.deepStrictEqual(pairs('--memory'), ['1024M']);
    assert.deepStrictEqual(pairs('--platform'), ['linux/arm64/v8']);
    // Entrypoint, image and arguments come last, in order
    assert.deepStrictEqual(args.slice(-4), ['--entrypoint', 'sleep', 'docker.io/library/alpine:latest', '600']);
  });

  it('uses create for a stopped container and a snapshot image when given', () => {
    const args = buildRecreateArgs(config, { ports: [], mounts: [] }, { start: false, image: 'web-snapshot:1' });
    assert.strictEqual(args[0], 'create');
    assert.ok(!args.includes('--detach'));
    assert.ok(!args.includes('--publish'));
    assert.deepStrictEqual(args.slice(-3), ['sleep', 'web-snapshot:1', '600']);
  });

  it('maps users and ulimits', () => {
    const custom = {
      ...config,
      initProcess: { ...config.initProcess, user: { raw: { userString: 'nginx' } }, rlimits: [{ limit: 'RLIMIT_NOFILE', soft: 1024, hard: 4096 }] },
    };
    const args = buildRecreateArgs(custom, { ports: [], mounts: [] }, { start: true });
    assert.deepStrictEqual(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2), ['--user', 'nginx']);
    assert.ok(args.includes('nofile=1024:4096'));
  });

  it('formats publish specs', () => {
    assert.strictEqual(formatPublishSpec({ hostAddress: '0.0.0.0', hostPort: 80, containerPort: 8080, proto: 'udp' }), '80:8080/udp');
  });

  it('validates edits', () => {
    assert.deepStrictEqual(validateEdits({ ports: [], mounts: [] }), []);
    const problems = validateEdits({
      ports: [
        { hostAddress: '0.0.0.0', hostPort: 80, containerPort: 0, proto: 'tcp' },
        { hostAddress: '0.0.0.0', hostPort: 80, containerPort: 81, proto: 'tcp' },
      ],
      mounts: [
        { kind: 'bind', source: 'relative', destination: 'data', readOnly: false },
        { kind: 'volume', source: 'bad name', destination: '/x', readOnly: false },
        { kind: 'tmpfs', source: '', destination: '/x', readOnly: false },
      ],
    });
    assert.deepStrictEqual(
      problems.map((p) => `${p.section}[${p.index}] ${p.reason}`),
      [
        'ports[0] portRange',
        'ports[1] duplicateHostPort',
        'mounts[0] relativeTarget',
        'mounts[0] relativeSource',
        'mounts[1] volumeName',
        'mounts[2] duplicateTarget',
      ],
    );
  });
});

describe('stats', () => {
  it('computes rates from cumulative counters', () => {
    const previous = { id: 'c', cpuUsageUsec: 1_000_000, networkRxBytes: 1000, networkTxBytes: 0, blockReadBytes: 0, blockWriteBytes: 0 };
    const current = {
      id: 'c',
      cpuUsageUsec: 2_000_000,
      networkRxBytes: 3000,
      networkTxBytes: 500,
      blockReadBytes: 4096,
      blockWriteBytes: 0,
      memoryUsageBytes: 1024,
      memoryLimitBytes: 4096,
      numProcesses: 3,
    };
    const s = toSample(current, previous, 2000, 42);
    // 1 s of CPU time over 2 s = half a core
    assert.strictEqual(s.cpuPercent, 50);
    assert.strictEqual(s.rxBytesPerSec, 1000);
    assert.strictEqual(s.txBytesPerSec, 250);
    assert.strictEqual(s.readBytesPerSec, 2048);
    assert.strictEqual(s.memoryBytes, 1024);
    assert.strictEqual(s.processes, 3);
  });

  it('reports absolute values but no rates for the first reading', () => {
    const s = toSample({ id: 'c', cpuUsageUsec: 5, memoryUsageBytes: 2048, numProcesses: 2 }, undefined, 0, 1);
    assert.strictEqual(s.cpuPercent, null);
    assert.strictEqual(s.rxBytesPerSec, null);
    assert.strictEqual(s.writeBytesPerSec, null);
    assert.strictEqual(s.memoryBytes, 2048);
    assert.strictEqual(s.processes, 2);
  });

  it('treats a counter reset as zero instead of a negative rate', () => {
    const s = toSample({ id: 'c', cpuUsageUsec: 10, networkRxBytes: 1 }, { id: 'c', cpuUsageUsec: 5_000, networkRxBytes: 9_000 }, 1000, 0);
    assert.strictEqual(s.cpuPercent, 0);
    assert.strictEqual(s.rxBytesPerSec, 0);
  });
});
