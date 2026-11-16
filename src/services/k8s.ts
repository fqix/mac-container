// Kubernetes resources shown under a cluster, grouped like Lens, and the one-line status of each object. No vscode
// dependency.

export type K8sGroup =
  'workloads' | 'config' | 'network' | 'storage' | 'namespaces' | 'events';

export interface K8sKind {
  /** kubectl resource name, also the id used in context values */
  resource: string;
  /** Display name (Kubernetes kinds are not translated) */
  label: string;
  group: K8sGroup;
  namespaced: boolean;
  /** codicon */
  icon: string;
}

export const K8S_GROUPS: K8sGroup[] = [
  'workloads',
  'config',
  'network',
  'storage',
  'namespaces',
  'events',
];

export const K8S_KINDS: K8sKind[] = [
  {
    resource: 'pods',
    label: 'Pods',
    group: 'workloads',
    namespaced: true,
    icon: 'symbol-method',
  },
  {
    resource: 'deployments',
    label: 'Deployments',
    group: 'workloads',
    namespaced: true,
    icon: 'layers',
  },
  {
    resource: 'daemonsets',
    label: 'DaemonSets',
    group: 'workloads',
    namespaced: true,
    icon: 'layers',
  },
  {
    resource: 'statefulsets',
    label: 'StatefulSets',
    group: 'workloads',
    namespaced: true,
    icon: 'layers',
  },
  {
    resource: 'replicasets',
    label: 'ReplicaSets',
    group: 'workloads',
    namespaced: true,
    icon: 'layers',
  },
  {
    resource: 'jobs',
    label: 'Jobs',
    group: 'workloads',
    namespaced: true,
    icon: 'checklist',
  },
  {
    resource: 'cronjobs',
    label: 'CronJobs',
    group: 'workloads',
    namespaced: true,
    icon: 'watch',
  },
  {
    resource: 'configmaps',
    label: 'ConfigMaps',
    group: 'config',
    namespaced: true,
    icon: 'file-code',
  },
  {
    resource: 'secrets',
    label: 'Secrets',
    group: 'config',
    namespaced: true,
    icon: 'key',
  },
  {
    resource: 'services',
    label: 'Services',
    group: 'network',
    namespaced: true,
    icon: 'plug',
  },
  {
    resource: 'ingresses',
    label: 'Ingresses',
    group: 'network',
    namespaced: true,
    icon: 'globe',
  },
  {
    resource: 'persistentvolumeclaims',
    label: 'PersistentVolumeClaims',
    group: 'storage',
    namespaced: true,
    icon: 'database',
  },
  {
    resource: 'persistentvolumes',
    label: 'PersistentVolumes',
    group: 'storage',
    namespaced: false,
    icon: 'database',
  },
  {
    resource: 'storageclasses',
    label: 'StorageClasses',
    group: 'storage',
    namespaced: false,
    icon: 'server',
  },
  {
    resource: 'namespaces',
    label: 'Namespaces',
    group: 'namespaces',
    namespaced: false,
    icon: 'symbol-namespace',
  },
  {
    resource: 'events',
    label: 'Events',
    group: 'events',
    namespaced: true,
    icon: 'bell',
  },
];

export function kindOf(resource: string): K8sKind | undefined {
  return K8S_KINDS.find(k => k.resource === resource);
}

/** ok: healthy, warn: progressing or degraded, error: failed, none: no health to show */
export type K8sLevel = 'ok' | 'warn' | 'error' | 'none';

export interface K8sItem {
  resource: string;
  name: string;
  namespace?: string;
  createdAt?: string;
  /** Short status, e.g. Running, 2/2, ClusterIP */
  status?: string;
  level: K8sLevel;
  /** Further columns, e.g. restarts, ports, keys */
  details: string[];
  /** Pods: container names, for logs and shell */
  containers?: string[];
}

type Json = Record<string, any>;

const list = (value: unknown): Json[] =>
  Array.isArray(value) ? (value as Json[]) : [];

const count = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Ready / desired replicas of a Deployment, StatefulSet or ReplicaSet */
function replicas(
  ready: unknown,
  desired: unknown,
): Pick<K8sItem, 'status' | 'level'> {
  const r = count(ready);
  const d = count(desired);
  return {status: `${r}/${d}`, level: r >= d ? 'ok' : 'warn'};
}

/** What `kubectl get pods` shows in STATUS: a waiting or terminated reason wins over the phase */
function podStatus(pod: Json): Pick<K8sItem, 'status' | 'level' | 'details'> {
  const phase: string = pod.status?.phase ?? 'Unknown';
  const statuses = list(pod.status?.containerStatuses);
  const ready = statuses.filter(s => s.ready).length;
  const total = list(pod.spec?.containers).length || statuses.length;
  const restarts = statuses.reduce((sum, s) => sum + count(s.restartCount), 0);
  const reason =
    statuses.map(s => s.state?.waiting?.reason).find(Boolean) ??
    statuses
      .map(s => s.state?.terminated?.reason)
      .find(r => r && r !== 'Completed') ??
    (pod.metadata?.deletionTimestamp ? 'Terminating' : undefined) ??
    pod.status?.reason;
  const status = reason ?? phase;
  let level: K8sLevel;
  if (phase === 'Succeeded') {
    level = 'none';
  } else if (
    phase === 'Failed' ||
    /BackOff|Err|Error|OOMKilled|Invalid|Evicted/.test(status)
  ) {
    level = 'error';
  } else if (phase === 'Running' && !reason && ready === total) {
    level = 'ok';
  } else {
    level = 'warn';
  }
  return {
    status,
    level,
    details: [`${ready}/${total}`, plural(restarts, 'restart')],
  };
}

function servicePorts(spec: Json): string {
  return list(spec.ports)
    .map(
      p =>
        `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`,
    )
    .join(', ');
}

function summarize(
  resource: string,
  obj: Json,
): Omit<K8sItem, 'resource' | 'name' | 'namespace' | 'createdAt'> {
  const spec = (obj.spec ?? {}) as Json;
  const status = (obj.status ?? {}) as Json;
  switch (resource) {
    case 'pods':
      return {
        ...podStatus(obj),
        containers: list(spec.containers).map(c => String(c.name)),
      };
    case 'deployments':
      return {
        ...replicas(status.readyReplicas, spec.replicas ?? 1),
        details: [`${count(status.updatedReplicas)} up-to-date`],
      };
    case 'statefulsets':
      return {
        ...replicas(status.readyReplicas, spec.replicas ?? 1),
        details: [],
      };
    case 'replicasets':
      return {
        ...replicas(status.readyReplicas, spec.replicas ?? 1),
        details: [],
      };
    case 'daemonsets':
      return {
        ...replicas(status.numberReady, status.desiredNumberScheduled),
        details: [],
      };
    case 'jobs': {
      const failed = count(status.failed);
      const succeeded = count(status.succeeded);
      const completions = count(spec.completions ?? 1);
      const done = succeeded >= completions;
      return {
        status: `${succeeded}/${completions}`,
        level: done ? 'ok' : failed > 0 ? 'error' : 'warn',
        details: failed ? [plural(failed, 'failure')] : [],
      };
    }
    case 'cronjobs':
      return {
        status: spec.suspend ? 'Suspended' : spec.schedule,
        level: 'none',
        details: spec.suspend
          ? [spec.schedule]
          : [plural(list(status.active).length, 'active job')],
      };
    case 'configmaps':
      return {
        level: 'none',
        details: [
          plural(Object.keys({...obj.data, ...obj.binaryData}).length, 'key'),
        ],
      };
    case 'secrets':
      return {
        status: obj.type,
        level: 'none',
        details: [plural(Object.keys(obj.data ?? {}).length, 'key')],
      };
    case 'services':
      return {
        status: spec.type,
        level: 'none',
        details: [spec.clusterIP, servicePorts(spec)].filter(Boolean),
      };
    case 'ingresses':
      return {
        status: spec.ingressClassName,
        level: 'none',
        details: [
          list(spec.rules)
            .map(r => r.host ?? '*')
            .join(', '),
        ].filter(Boolean),
      };
    case 'persistentvolumeclaims':
      return {
        status: status.phase,
        level:
          status.phase === 'Bound'
            ? 'ok'
            : status.phase === 'Lost'
              ? 'error'
              : 'warn',
        details: [
          status.capacity?.storage ?? spec.resources?.requests?.storage,
          spec.storageClassName,
        ].filter(Boolean),
      };
    case 'persistentvolumes':
      return {
        status: status.phase,
        level:
          status.phase === 'Failed'
            ? 'error'
            : status.phase === 'Released'
              ? 'warn'
              : 'ok',
        details: [
          spec.capacity?.storage,
          spec.claimRef
            ? `${spec.claimRef.namespace}/${spec.claimRef.name}`
            : undefined,
        ].filter(Boolean),
      };
    case 'storageclasses':
      return {
        status:
          obj.metadata?.annotations?.[
            'storageclass.kubernetes.io/is-default-class'
          ] === 'true'
            ? 'default'
            : undefined,
        level: 'none',
        details: [obj.provisioner].filter(Boolean),
      };
    case 'namespaces':
      return {
        status: status.phase,
        level: status.phase === 'Active' ? 'ok' : 'warn',
        details: [],
      };
    case 'events': {
      const object = obj.involvedObject ?? obj.regarding ?? {};
      return {
        status: obj.reason,
        level: obj.type === 'Warning' ? 'warn' : 'none',
        details: [
          `${object.kind ?? ''}/${object.name ?? ''}`,
          obj.count > 1 ? `×${obj.count}` : undefined,
          obj.message ?? obj.note,
        ].filter(Boolean),
      };
    }
    default:
      return {level: 'none', details: []};
  }
}

/** When an event last happened; events are listed newest first */
function eventTime(obj: Json): string {
  return (
    obj.lastTimestamp ??
    obj.eventTime ??
    obj.series?.lastObservedTime ??
    obj.metadata?.creationTimestamp ??
    ''
  );
}

/** Maps `kubectl get <resource> -o json` into tree items, sorted by namespace and name (events: newest first) */
export function parseK8sList(
  resource: string,
  data: unknown,
  limit = 200,
): K8sItem[] {
  const items = list((data as Json | undefined)?.items).map(obj => ({
    obj,
    item: {
      resource,
      name: String(obj.metadata?.name ?? ''),
      namespace: obj.metadata?.namespace,
      createdAt:
        resource === 'events'
          ? eventTime(obj) || undefined
          : obj.metadata?.creationTimestamp,
      ...summarize(resource, obj),
    } as K8sItem,
  }));
  if (resource === 'events') {
    // Timestamps mix seconds and microseconds, so compare them as dates
    const time = (obj: Json) => Date.parse(eventTime(obj)) || 0;
    items.sort((a, b) => time(b.obj) - time(a.obj));
  } else {
    items.sort(
      (a, b) =>
        (a.item.namespace ?? '').localeCompare(b.item.namespace ?? '') ||
        a.item.name.localeCompare(b.item.name),
    );
  }
  return items.slice(0, limit).map(i => i.item);
}

/** A Kubernetes Node as `kubectl get nodes` shows it */
export interface K8sNodeInfo {
  name: string;
  ready: boolean;
  /** Ready / NotReady / SchedulingDisabled etc. */
  status: string;
  roles: string[];
  kubeletVersion?: string;
}

export function parseK8sNodes(data: unknown): K8sNodeInfo[] {
  return list((data as Json | undefined)?.items).map(node => {
    const ready = list(node.status?.conditions).find(c => c.type === 'Ready');
    const isReady = ready?.status === 'True';
    const status = [
      isReady ? 'Ready' : 'NotReady',
      node.spec?.unschedulable ? 'SchedulingDisabled' : undefined,
    ]
      .filter(Boolean)
      .join(',');
    const roles = Object.keys(node.metadata?.labels ?? {})
      .filter(l => l.startsWith('node-role.kubernetes.io/'))
      .map(l => l.slice('node-role.kubernetes.io/'.length))
      .filter(Boolean);
    return {
      name: String(node.metadata?.name ?? ''),
      ready: isReady,
      status,
      roles,
      kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
    };
  });
}
