// Slim models used inside the extension, converted from container CLI JSON by parse.ts

export type ContainerState = 'running' | 'stopped' | 'stopping' | 'unknown' | string;

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
