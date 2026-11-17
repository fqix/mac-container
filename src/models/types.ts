// Slim models used inside the extension, converted from container CLI JSON by parse.ts

export type ContainerState =
  'running' | 'stopped' | 'stopping' | 'unknown' | string;

export interface ContainerMount {
  /** volume: named volume, bind: host directory shared via virtiofs */
  kind: 'volume' | 'bind' | 'tmpfs' | string;
  /** Volume name for named volumes, host path for bind mounts */
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface PortMapping {
  hostAddress: string;
  hostPort: number;
  containerPort: number;
  proto: string;
}

export interface ContainerSummary {
  id: string;
  image: string;
  state: ContainerState;
  command: string;
  createdAt?: string;
  startedAt?: string;
  /** IPv4 address without prefix length, e.g. 192.168.64.5 */
  ipv4?: string;
  networks: string[];
  ports: string[];
  publishedPorts: PortMapping[];
  mounts: ContainerMount[];
  /** Set by container-compose through the com.docker.compose.* labels */
  composeProject?: string;
  composeService?: string;
  cpus?: number;
  memoryBytes?: number;
  platform?: string;
  /** Process user from the image USER or --user: a name, uid or name:group */
  user?: string;
  /** Working directory of the init process */
  workdir?: string;
  labels: Record<string, string>;
  /** The BuildKit builder started by `container build` / `container builder start`, shown in the Builder view */
  builder: boolean;
}

export interface ImageSummary {
  /** Full reference, e.g. docker.io/library/alpine:latest. Apple container addresses images by reference only, not by digest */
  reference: string;
  /** Short display name, e.g. alpine:latest */
  displayName: string;
  digest: string;
  createdAt?: string;
  /** Sum of all platform variant sizes */
  sizeBytes: number;
  platforms: string[];
}

export interface NetworkSummary {
  id: string;
  mode?: string;
  ipv4Subnet?: string;
  ipv4Gateway?: string;
  ipv6Subnet?: string;
  builtin: boolean;
}

export interface VolumeSummary {
  name: string;
  driver?: string;
  format?: string;
  sizeBytes?: number;
  source?: string;
  createdAt?: string;
}

export interface RegistrySummary {
  /** Registry hostname, optionally with a port, e.g. ghcr.io or localhost:5000 */
  hostname: string;
  username: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface SystemStatus {
  running: boolean;
  clientVersion?: string;
  serverVersion?: string;
  containersRunning?: number;
  containersTotal?: number;
  images?: number;
  hostCpus?: number;
  operatingSystem?: string;
  /** Data directory of the container service */
  appRoot?: string;
  installRoot?: string;
}

/** A `container machine`: a persistent Linux environment with the Mac user and home directory, from `machine list` */
export interface MachineSummary {
  id: string;
  /** running / stopped / stopping / unknown */
  status: string;
  /** The machine `container machine run` uses without -n */
  isDefault: boolean;
  /** Only while running */
  ipv4?: string;
  cpus?: number;
  memoryBytes?: number;
  /** Space used by the machine's persistent storage */
  diskBytes?: number;
  createdAt?: string;
}

/** What `machine inspect` adds to the list output */
export interface MachineDetails extends MachineSummary {
  image?: string;
  platform?: string;
  /** The machine's account, matching the Mac user unless set at creation */
  username?: string;
  uid?: number;
  /** The account's Linux home; the Mac home is mounted at its own path */
  home?: string;
  /** rw / ro / none */
  homeMount?: string;
  /** The container backing the machine; changes on every boot */
  containerId?: string;
  startedAt?: string;
}

/** A node of a `container cluster`; the node is a container with the same name */
export interface ClusterNode {
  name: string;
  /** control-plane / worker */
  roles: string[];
  /** e.g. running; missing when the cluster status does not list the node */
  status?: string;
  addresses: string[];
  /** host->container, e.g. 6446->6443 for the API server */
  ports: string[];
}

export interface ClusterSummary {
  name: string;
  state: string;
  kubernetesVersion?: string;
  createdAt?: string;
  sharedImageStore: boolean;
  cni?: string;
  nodes: ClusterNode[];
}

/** One row of `container system df` */
export interface DiskUsageEntry {
  total: number;
  active: number;
  sizeBytes: number;
  reclaimableBytes: number;
}

export interface DiskUsage {
  images: DiskUsageEntry;
  containers: DiskUsageEntry;
  volumes: DiskUsageEntry;
}

export interface ContainerStats {
  id: string;
  cpuUsageUsec?: number;
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  blockReadBytes?: number;
  blockWriteBytes?: number;
  numProcesses?: number;
}
