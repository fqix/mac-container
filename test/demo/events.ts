// Scene markers and action requests written by the demo script and read by the recorder

import * as fs from 'fs';

export const EVENTS_ENV = 'APPLE_CONTAINER_DEMO_EVENTS';

export type DemoEvent =
  | { type: 'scene-start' | 'scene-end'; name: string; t: number }
  | { type: 'action'; id: string; name: string; payload?: Record<string, any> };

export function appendEvent(file: string, event: DemoEvent): void {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}
