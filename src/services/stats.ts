// Turns two consecutive `container stats` readings into rates for the stats chart. No vscode dependency.

import type { ContainerStats } from '../models/types';

export interface StatsSample {
  /** Unix time in milliseconds */
  time: number;
  /** 100 = one fully used CPU core. Rates are null for the first reading, which has nothing to compare with */
  cpuPercent: number | null;
  memoryBytes: number;
  memoryLimitBytes: number;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
  processes: number;
}

/** Messages posted from the extension to the stats webview */
export type StatsMessage = { type: 'sample'; sample: StatsSample } | { type: 'status'; text: string; error?: boolean };

/** Counters are cumulative; a counter that went backwards (container restarted) yields a zero rate */
function rate(current: number | undefined, previous: number | undefined, seconds: number): number | null {
  if (previous === undefined) {
    return null;
  }
  if (current === undefined || seconds <= 0 || current < previous) {
    return 0;
  }
  return (current - previous) / seconds;
}

export function toSample(current: ContainerStats, previous: ContainerStats | undefined, elapsedMs: number, time: number): StatsSample {
  const seconds = elapsedMs / 1000;
  return {
    time,
    // cpuUsageUsec is CPU time in microseconds: usec per second / 1e6 * 100
    cpuPercent: previous ? (rate(current.cpuUsageUsec, previous.cpuUsageUsec, seconds) ?? 0) / 10_000 : null,
    memoryBytes: current.memoryUsageBytes ?? 0,
    memoryLimitBytes: current.memoryLimitBytes ?? 0,
    rxBytesPerSec: rate(current.networkRxBytes, previous?.networkRxBytes, seconds),
    txBytesPerSec: rate(current.networkTxBytes, previous?.networkTxBytes, seconds),
    readBytesPerSec: rate(current.blockReadBytes, previous?.blockReadBytes, seconds),
    writeBytesPerSec: rate(current.blockWriteBytes, previous?.blockWriteBytes, seconds),
    processes: current.numProcesses ?? 0,
  };
}
