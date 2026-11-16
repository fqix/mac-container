// Messages between the system overview panel and its webview. No vscode dependency.

import type {DiskUsage, SystemStatus} from '../models/types';

export type DiskUsageKind = keyof DiskUsage;

export type SystemToWebview =
  | {type: 'loading'}
  | {
      type: 'update';
      status: SystemStatus;
      /** Missing while the service is stopped or when `system df` failed */
      usage?: DiskUsage;
      error?: string;
      /** Unix time in milliseconds */
      updatedAt: number;
    };

export type SystemFromWebview =
  | {type: 'ready'}
  | {type: 'refresh'}
  | {type: 'start'}
  | {type: 'prune'; kind: DiskUsageKind}
  | {type: 'reveal'; path: string}
  | {type: 'showJson'};

/** Share of `part` in `whole` as 0..100; 0 when `whole` is empty */
export function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0;
}
