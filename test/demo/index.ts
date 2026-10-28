// Demo script run in the extension host by runDemo.ts. It prepares demo resources, then plays each
// scene through VS Code commands; UI steps inside webviews and dialogs are delegated to the recorder.
import * as fs from 'fs';

import * as vscode from 'vscode';

import type { ExtensionApi } from '../../src/extension';
import type { WebviewStep } from './runDemo';
import { appendEvent, EVENTS_ENV } from './events';

const IMAGE = 'docker.io/library/alpine:latest';
const eventsFile = process.env[EVENTS_ENV]!;
const only = (process.env.DEMO_SCENES ?? '').split(',').filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args);

async function scene(name: string, play: () => Promise<void>): Promise<void> {
  if (only.length && !only.includes(name)) {
    return;
  }
  await run('workbench.action.closeAllEditors');
  await run('notifications.clearAll');
  await sleep(800);
  appendEvent(eventsFile, { type: 'scene-start', name, t: Date.now() / 1000 });
  await play();
  appendEvent(eventsFile, { type: 'scene-end', name, t: Date.now() / 1000 });
}

let actionId = 0;
/** Asks the recorder (outside VS Code) to perform a UI action and waits until it is done */
async function action(name: string, payload: Record<string, unknown>): Promise<void> {
  const id = String(++actionId);
  appendEvent(eventsFile, { type: 'action', id, name, payload });
  const ack = `${eventsFile}.ack-${id}`;
  for (let i = 0; i < 300 && !fs.existsSync(ack); i++) {
    await sleep(100);
  }
  const result = fs.existsSync(ack) ? fs.readFileSync(ack, 'utf8') : 'timeout';
  if (result !== 'ok') {
    throw new Error(`action ${name} failed: ${result}`);
  }
}

async function findNode(api: ExtensionApi, id: string): Promise<vscode.TreeItem | undefined> {
  const roots = await api.views.containers.getChildren();
  for (const node of roots) {
    if (node.id === id) {
      return node;
    }
    if (node.contextValue === 'composeProject') {
      const child = (await api.views.containers.getChildren(node)).find((n) => n.id === id);
      if (child) {
        return child;
      }
    }
  }
  return undefined;
}

/** Walks the focused tree with list commands so the selection visibly moves */
async function treeSteps(steps: string[], pause = 450): Promise<void> {
  for (const step of steps) {
    await run(step);
    await sleep(pause);
  }
}

async function cleanup(api: ExtensionApi): Promise<void> {
  const ignore = () => undefined;
  await api.cli.run(['delete', '--force', 'shop-web', 'shop-worker', 'api', 'cache']).catch(ignore);
  await api.cli.run(['volume', 'delete', 'shop-data', 'api-data']).catch(ignore);
}

async function setup(api: ExtensionApi): Promise<void> {
  await cleanup(api);
  const compose = (service: string) => ['--label', 'com.docker.compose.project=shop', '--label', `com.docker.compose.service=${service}`];
  await api.cli.run(['volume', 'create', 'shop-data']);
  await api.cli.run(['volume', 'create', 'api-data']);
  const runDetached = (args: string[]) => api.cli.run(['run', '--detach', ...args], { timeoutMs: 120_000 });
  await runDetached(['--name', 'shop-web', ...compose('web'), '--publish', '8080:80', '--volume', 'shop-data:/data', IMAGE, 'sleep', 'infinity']);
  await runDetached(['--name', 'shop-worker', ...compose('worker'), IMAGE, 'sleep', 'infinity']);
  // Busy for 3 s, idle for 2 s, so the CPU chart has something to show
  await runDetached([
    '--name',
    'api',
    '--publish',
    '3000:3000',
    IMAGE,
    'sh',
    '-c',
    'while :; do timeout 3 sh -c "while :; do :; done"; dd if=/dev/zero of=/tmp/blob bs=1M count=64 2>/dev/null; sleep 2; done',
  ]);
  await api.cli.run(['create', '--name', 'cache', IMAGE, 'sleep', 'infinity']);
}

export async function run_(): Promise<void> {
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'apple-container')!;
  const api = (await extension.activate()) as ExtensionApi;
  await setup(api);
  await run('workbench.action.closeAuxiliaryBar');
  await run('workbench.action.closePanel');
  await run('workbench.view.extension.appleContainer');
  await sleep(1500);
  // Wider sidebar so container descriptions are readable: drag the sash between sidebar and editor
  await action('drag', { from: [219, 400], to: [400, 400] });
  // Modal dialogs are refused in extension test mode, so answer the recreate confirmation here
  (vscode.window as any).showWarningMessage = async (_message: string, _options: unknown, action: string) => {
    await sleep(800);
    return action;
  };
  await sleep(3000);

  try {
    await scene('overview', async () => {
      await run('appleContainer.containers.focus');
      await sleep(800);
      // shop group -> shop-web -> Volumes / Ports
      await treeSteps(['list.focusFirst', 'list.focusDown', 'list.expand'], 600);
      await sleep(600);
      await treeSteps(['list.focusDown', 'list.expand', 'list.focusDown', 'list.focusDown', 'list.expand'], 600);
      await sleep(1000);
      await run('appleContainer.container.inspect', await findNode(api, 'container:shop-web'));
      await sleep(2500);
      await run('appleContainer.images.focus');
      await sleep(1200);
      await run('appleContainer.volumes.focus');
      await sleep(1200);
      // The status bar menu
      void run('appleContainer.system.menu');
      await sleep(2200);
      await run('workbench.action.closeQuickOpen');
      await sleep(500);
      await run('workbench.action.quickOpen', '>Apple Container: ');
      await sleep(2500);
      await run('workbench.action.closeQuickOpen');
      await sleep(600);
    });

    await scene('stats', async () => {
      const node = await findNode(api, 'container:api');
      await run('appleContainer.container.stats', node);
      await sleep(24_000);
    });

    await scene('edit', async () => {
      const node = await findNode(api, 'container:api');
      await run('appleContainer.container.edit', node);
      await sleep(1800);
      const steps: WebviewStep[] = [
        { click: 'button', text: 'Add Port', pause: 500 },
        { type: '8443', into: 'td.col-narrow input[type=number]', index: -2 },
        { type: '443', into: 'td.col-narrow input[type=number]', index: -1, pause: 600 },
        { click: 'button', text: 'Add Mount', pause: 500 },
        { type: 'api-data', into: 'input[list=volume-names]', pause: 300 },
        { type: '/var/lib/api', into: 'input[placeholder="/data"]', pause: 900 },
        { click: 'button', text: 'Save and Recreate', pause: 300 },
      ];
      await action('webview', { marker: '.edit', steps });
      // Wait for the recreated container, then show its new ports and mounts in the tree
      for (let i = 0; i < 60; i++) {
        const [c] = (await api.cli.listContainers()).filter((x) => x.id === 'api');
        if (c?.state === 'running' && c.publishedPorts.some((p) => p.hostPort === 8443)) {
          break;
        }
        await sleep(500);
      }
      await sleep(1500);
      await run('appleContainer.containers.focus');
      await run('workbench.actions.treeView.appleContainer.containers.collapseAll');
      await sleep(500);
      // shop (collapsed) -> api -> Volumes -> its mount -> Ports
      await treeSteps(['list.focusFirst', 'list.focusDown', 'list.expand', 'list.focusDown', 'list.expand', 'list.focusDown', 'list.focusDown', 'list.expand'], 550);
      await sleep(2500);
    });
  } finally {
    await cleanup(api);
  }
}

export { run_ as run };
