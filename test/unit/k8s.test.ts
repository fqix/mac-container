import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  K8S_GROUPS,
  K8S_KINDS,
  kindOf,
  parseK8sList,
  parseK8sNodes,
} from '../../src/services/k8s';

// Trimmed `kubectl get <resource> -A -o json` of a 1.7.1 `container cluster` (Kubernetes v1.35.5)
const fixture = (name: string) =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../test/fixtures', name),
      'utf8',
    ),
  );

const pod = (status: object, spec: object = {containers: [{name: 'app'}]}) => ({
  items: [{metadata: {name: 'p', namespace: 'default'}, spec, status}],
});

describe('k8s', () => {
  it('puts every kind in a group shown under the cluster', () => {
    for (const kind of K8S_KINDS) {
      assert.ok(K8S_GROUPS.includes(kind.group), kind.resource);
    }
    assert.strictEqual(kindOf('pods')?.label, 'Pods');
    assert.strictEqual(kindOf('nope'), undefined);
  });

  it('summarizes pods like kubectl get pods', () => {
    const items = parseK8sList('pods', fixture('k8s-pods.json'));
    assert.strictEqual(items.length, 10);
    const coredns = items.find(i => i.name.startsWith('coredns-'))!;
    assert.strictEqual(coredns.namespace, 'kube-system');
    assert.strictEqual(coredns.status, 'Running');
    assert.strictEqual(coredns.level, 'ok');
    assert.deepStrictEqual(coredns.details, ['1/1', '0 restarts']);
    assert.deepStrictEqual(coredns.containers, ['coredns']);
    // Sorted by namespace, then name
    const keys = items.map(i => `${i.namespace}/${i.name}`);
    assert.deepStrictEqual(keys, [...keys].sort());
  });

  it('shows the waiting reason and its severity', () => {
    const [crash] = parseK8sList(
      'pods',
      pod({
        phase: 'Running',
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 4,
            state: {waiting: {reason: 'CrashLoopBackOff'}},
          },
        ],
      }),
    );
    assert.strictEqual(crash.status, 'CrashLoopBackOff');
    assert.strictEqual(crash.level, 'error');
    assert.deepStrictEqual(crash.details, ['0/1', '4 restarts']);

    const [pending] = parseK8sList('pods', pod({phase: 'Pending'}));
    assert.strictEqual(pending.status, 'Pending');
    assert.strictEqual(pending.level, 'warn');

    const [done] = parseK8sList(
      'pods',
      pod({
        phase: 'Succeeded',
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 0,
            state: {terminated: {reason: 'Completed'}},
          },
        ],
      }),
    );
    assert.strictEqual(done.status, 'Succeeded');
    assert.strictEqual(done.level, 'none');
  });

  it('summarizes deployments, services and jobs', () => {
    const [coredns] = parseK8sList(
      'deployments',
      fixture('k8s-deployments.json'),
    );
    assert.strictEqual(coredns.status, '2/2');
    assert.strictEqual(coredns.level, 'ok');

    const services = parseK8sList('services', fixture('k8s-services.json'));
    const dns = services.find(s => s.name === 'kube-dns')!;
    assert.strictEqual(dns.status, 'ClusterIP');
    assert.match(dns.details[1], /53\/UDP/);

    const [job] = parseK8sList('jobs', {
      items: [
        {
          metadata: {name: 'j'},
          spec: {completions: 2},
          status: {succeeded: 1, failed: 1},
        },
      ],
    });
    assert.strictEqual(job.status, '1/2');
    assert.strictEqual(job.level, 'error');
  });

  it('lists events newest first, mixing second and microsecond times', () => {
    const events = parseK8sList('events', fixture('k8s-events.json'));
    assert.strictEqual(events[0].status, 'Starting');
    const times = events.map(e => Date.parse(e.createdAt!));
    assert.deepStrictEqual(
      times,
      [...times].sort((a, b) => b - a),
    );
    assert.ok(events.every(e => e.level === 'none'));
    assert.strictEqual(events[0].details[0], 'Node/e2e-cluster-worker-1');
    assert.strictEqual(
      parseK8sList('events', {items: [{type: 'Warning', reason: 'BackOff'}]})[0]
        .level,
      'warn',
    );
  });

  it('caps long lists', () => {
    const items = Array.from({length: 5}, (_, i) => ({
      metadata: {name: `cm${i}`, namespace: 'n'},
      data: {a: '1'},
    }));
    const listed = parseK8sList('configmaps', {items}, 3);
    assert.strictEqual(listed.length, 3);
    assert.deepStrictEqual(listed[0].details, ['1 key']);
  });

  it('reads node readiness and roles', () => {
    const nodes = parseK8sNodes(fixture('k8s-nodes.json'));
    const control = nodes.find(n => n.name === 'e2e-cluster')!;
    assert.strictEqual(control.ready, true);
    assert.strictEqual(control.status, 'Ready');
    assert.deepStrictEqual(control.roles, ['control-plane']);
    assert.strictEqual(control.kubeletVersion, 'v1.35.5');
    const [cordoned] = parseK8sNodes({
      items: [
        {
          metadata: {name: 'n'},
          spec: {unschedulable: true},
          status: {conditions: [{type: 'Ready', status: 'False'}]},
        },
      ],
    });
    assert.strictEqual(cordoned.status, 'NotReady,SchedulingDisabled');
    assert.deepStrictEqual(parseK8sNodes(undefined), []);
  });
});
