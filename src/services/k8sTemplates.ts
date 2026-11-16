// YAML starting points for "New Resource", like Lens's create-resource templates. No vscode dependency.

/** Resources with a template, in the order offered */
export const TEMPLATE_RESOURCES = [
  'deployments',
  'services',
  'pods',
  'configmaps',
  'secrets',
  'jobs',
  'cronjobs',
  'statefulsets',
  'daemonsets',
  'ingresses',
  'persistentvolumeclaims',
  'namespaces',
] as const;

export type TemplateResource = (typeof TEMPLATE_RESOURCES)[number];

export function hasTemplate(resource: string): resource is TemplateResource {
  return (TEMPLATE_RESOURCES as readonly string[]).includes(resource);
}

/** A pod spec running `image`, shared by the workload templates */
function podSpec(indent: string, image = 'nginx:stable'): string {
  return [
    'containers:',
    '  - name: app',
    `    image: ${image}`,
    '    ports:',
    '      - containerPort: 80',
  ]
    .map(line => indent + line)
    .join('\n');
}

/** The manifest for `resource` in `namespace` (ignored for cluster-scoped kinds) */
export function k8sTemplate(
  resource: TemplateResource,
  namespace: string,
): string {
  const meta = (kind: string, apiVersion: string, name: string) =>
    [
      `apiVersion: ${apiVersion}`,
      `kind: ${kind}`,
      'metadata:',
      `  name: ${name}`,
      `  namespace: ${namespace}`,
    ].join('\n');
  switch (resource) {
    case 'deployments':
      return `${meta('Deployment', 'apps/v1', 'my-app')}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
${podSpec('      ')}
`;
    case 'statefulsets':
      return `${meta('StatefulSet', 'apps/v1', 'my-app')}
spec:
  serviceName: my-app
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
${podSpec('      ')}
`;
    case 'daemonsets':
      return `${meta('DaemonSet', 'apps/v1', 'my-agent')}
spec:
  selector:
    matchLabels:
      app: my-agent
  template:
    metadata:
      labels:
        app: my-agent
    spec:
${podSpec('      ')}
`;
    case 'services':
      return `${meta('Service', 'v1', 'my-app')}
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
`;
    case 'pods':
      return `${meta('Pod', 'v1', 'my-pod')}
  labels:
    app: my-pod
spec:
${podSpec('  ')}
`;
    case 'configmaps':
      return `${meta('ConfigMap', 'v1', 'my-config')}
data:
  key: value
`;
    case 'secrets':
      return `${meta('Secret', 'v1', 'my-secret')}
type: Opaque
# stringData is encoded to base64 data by the API server
stringData:
  key: value
`;
    case 'jobs':
      return `${meta('Job', 'batch/v1', 'my-job')}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:stable
          command: ["sh", "-c", "echo hello"]
`;
    case 'cronjobs':
      return `${meta('CronJob', 'batch/v1', 'my-cronjob')}
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:stable
              command: ["sh", "-c", "date"]
`;
    case 'ingresses':
      return `${meta('Ingress', 'networking.k8s.io/v1', 'my-app')}
spec:
  rules:
    - host: my-app.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80
`;
    case 'persistentvolumeclaims':
      return `${meta('PersistentVolumeClaim', 'v1', 'my-data')}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`;
    case 'namespaces':
      return `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`;
  }
}
