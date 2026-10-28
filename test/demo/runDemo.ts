// Records the README animations: launches VS Code with the extension and a remote debugging port,
// runs the demo script (test/demo/index.ts) in the extension host and captures the window over CDP.
// The demo script marks scenes in an events file; each scene becomes docs/media/<scene>.gif.
//
//   npm run demo                 # all scenes
//   DEMO_SCENES=stats npm run demo
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

import { CdpSession, listTargets } from './cdp';
import { DemoEvent, EVENTS_ENV } from './events';
import { Frame, writeGif } from './gif';

const PORT = 9339;
const WIDTH = 1280;
const HEIGHT = 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(250);
  }
}

class Recorder {
  readonly frames: Frame[] = [];
  private page!: CdpSession;
  private handled = new Set<string>();
  private stopped = false;

  constructor(private readonly eventsFile: string) {}

  async start(): Promise<void> {
    const target = await waitFor('VS Code workbench', async () =>
      (await listTargets(PORT)).find((t) => t.type === 'page' && t.url.includes('workbench')),
    );
    this.page = await CdpSession.connect(target.webSocketDebuggerUrl);
    await this.page.send('Page.enable');
    // Fixed viewport so every recording has the same dimensions (Electron has no Browser.setWindowBounds)
    await this.page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    void this.captureLoop();
    void this.actionLoop();
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Polls screenshots instead of Page.startScreencast: the screencast only emits frames when the
   * workbench itself repaints, so updates inside webviews (out-of-process iframes) would be missed.
   */
  private async captureLoop(): Promise<void> {
    while (!this.stopped) {
      const started = Date.now();
      try {
        const { data } = await this.page.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        const png = Buffer.from(data, 'base64');
        const last = this.frames[this.frames.length - 1];
        // Identical frames only extend the previous one
        if (!last || !last.png.equals(png)) {
          // Capture start time lines up with the scene markers written by the demo script
          this.frames.push({ time: started / 1000, png });
        }
      } catch {
        // window closing
      }
      await sleep(Math.max(0, 100 - (Date.now() - started)));
    }
  }

  /** Performs the UI actions the demo script cannot do from the extension host (webview input, dialogs) */
  private async actionLoop(): Promise<void> {
    while (!this.stopped) {
      for (const event of readEvents(this.eventsFile)) {
        if (event.type === 'action' && !this.handled.has(event.id)) {
          this.handled.add(event.id);
          try {
            await this.perform(event.name, event.payload ?? {});
            fs.writeFileSync(`${this.eventsFile}.ack-${event.id}`, 'ok');
          } catch (error) {
            // Keep what was on screen to debug the failed step
            const last = this.frames[this.frames.length - 1];
            if (last && process.env.DEMO_DEBUG_DIR) {
              fs.writeFileSync(path.join(process.env.DEMO_DEBUG_DIR, `failed-${event.name}.png`), last.png);
            }
            fs.writeFileSync(`${this.eventsFile}.ack-${event.id}`, `error: ${String(error)}`);
          }
        }
      }
      await sleep(150);
    }
  }

  private async perform(name: string, payload: Record<string, any>): Promise<void> {
    switch (name) {
      case 'webview':
        return this.inWebview(payload.marker, payload.steps);
      case 'drag': {
        // e.g. the sidebar sash, which has no command to set its width
        const { from, to } = payload as { from: [number, number]; to: [number, number] };
        const mouse = (type: string, [x, y]: [number, number]) =>
          this.page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
        await mouse('mouseMoved', from);
        await mouse('mousePressed', from);
        for (let i = 1; i <= 10; i++) {
          await mouse('mouseMoved', [from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10]);
          await sleep(20);
        }
        await mouse('mouseReleased', to);
        return;
      }
      case 'click-dialog':
        await waitFor('dialog', () =>
          this.page.evaluate<boolean | undefined>(`(() => {
            const button = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((b) => b.textContent.trim() === ${JSON.stringify(payload.label)});
            if (!button) return undefined;
            button.click();
            return true;
          })()`),
        10_000,
        );
        return;
      default:
        throw new Error(`unknown action ${name}`);
    }
  }

  /** Runs steps inside the webview whose document contains `marker` (a CSS selector) */
  private async inWebview(marker: string, steps: WebviewStep[]): Promise<void> {
    const session = await waitFor(
      `webview ${marker}`,
      async () => {
        for (const target of await listTargets(PORT)) {
          if (!target.url.startsWith('vscode-webview://')) {
            continue;
          }
          const s = await CdpSession.connect(target.webSocketDebuggerUrl);
          const found = await s.evaluate<boolean>(`!!(document.querySelector('#active-frame')?.contentDocument ?? document).querySelector(${JSON.stringify(marker)})`);
          if (found) {
            return s;
          }
          s.close();
        }
        return undefined;
      },
      15_000,
    );
    try {
      for (const step of steps) {
        await session.evaluate(webviewStepScript(step));
        await sleep(step.pause ?? 400);
      }
    } finally {
      session.close();
    }
  }
}

/** A scripted interaction inside a webview; selectors are evaluated in the React app's document */
export type WebviewStep =
  | { click: string; text?: string; pause?: number }
  | { type: string; into: string; index?: number; pause?: number };

function webviewStepScript(step: WebviewStep): string {
  const prelude = `
    const doc = document.querySelector('#active-frame')?.contentDocument ?? document;
    const win = doc.defaultView;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`;
  if ('click' in step) {
    return `(async () => {${prelude}
      const all = [...doc.querySelectorAll(${JSON.stringify(step.click)})];
      const el = ${step.text === undefined ? 'all[0]' : `all.find((e) => e.textContent.includes(${JSON.stringify(step.text)}))`};
      if (!el) throw new Error('not found: ${step.click}');
      el.click();
    })()`;
  }
  // React controlled inputs need the native value setter plus an input event per keystroke
  return `(async () => {${prelude}
    const inputs = [...doc.querySelectorAll(${JSON.stringify(step.into)})];
    const el = inputs.at(${step.index ?? -1});
    if (!el) throw new Error('not found: ${step.into}');
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    let value = '';
    for (const ch of ${JSON.stringify(step.type)}) {
      value += ch;
      setter.call(el, value);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      await sleep(90);
    }
  })()`;
}

function readEvents(file: string): DemoEvent[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DemoEvent);
}

function writeScenes(frames: Frame[], events: DemoEvent[], outDir: string): string[] {
  const written: string[] = [];
  for (const start of events) {
    if (start.type !== 'scene-start') {
      continue;
    }
    const end = events.find((e): e is Extract<DemoEvent, { t: number }> => e.type === 'scene-end' && e.name === start.name);
    if (!end) {
      continue;
    }
    // The frame on screen when the scene starts, then every frame until it ends
    const before = [...frames].reverse().find((f) => f.time <= start.t);
    const inside = frames.filter((f) => f.time > start.t && f.time <= end.t);
    const sceneFrames = [...(before ? [{ time: start.t, png: before.png }] : []), ...inside];
    if (!sceneFrames.length) {
      continue;
    }
    // Debug aid: roughly one PNG per second of the scene
    if (process.env.DEMO_DEBUG_DIR) {
      let next = start.t;
      for (const frame of sceneFrames) {
        if (frame.time >= next) {
          fs.writeFileSync(path.join(process.env.DEMO_DEBUG_DIR, `${start.name}-${(frame.time - start.t).toFixed(1).padStart(5, '0')}s.png`), frame.png);
          next = frame.time + 1;
        }
      }
    }
    const file = path.join(outDir, `${start.name}.gif`);
    writeGif(file, sceneFrames, end.t);
    written.push(`${file} (${sceneFrames.length} frames, ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  return written;
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-container-demo-'));
  const workspace = path.join(tmp, 'shop');
  fs.mkdirSync(workspace);
  const userDir = path.join(tmp, 'user-data', 'User');
  fs.mkdirSync(userDir, { recursive: true });
  // A clean, distraction-free window
  fs.writeFileSync(
    path.join(userDir, 'settings.json'),
    JSON.stringify(
      {
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'workbench.layoutControl.enabled': false,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'window.commandCenter': false,
        'window.dialogStyle': 'custom',
        'window.zoomLevel': 0,
        'chat.disableAIFeatures': true,
        'editor.minimap.enabled': false,
        'security.workspace.trust.enabled': false,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'appleContainer.refreshInterval': 2,
      },
      null,
      2,
    ),
  );
  const eventsFile = path.join(tmp, 'events.jsonl');
  const outDir = path.join(root, 'docs', 'media');
  fs.mkdirSync(outDir, { recursive: true });

  const recorder = new Recorder(eventsFile);
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const run = runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'index.js'),
    extensionTestsEnv: { [EVENTS_ENV]: eventsFile, DEMO_SCENES: process.env.DEMO_SCENES ?? '' },
    launchArgs: [
      workspace,
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(tmp, 'user-data')}`,
      `--extensions-dir=${path.join(tmp, 'extensions')}`,
    ],
  });
  try {
    await recorder.start();
    await run;
  } finally {
    recorder.stop();
    // Scenes that completed are written even when a later one failed
    for (const line of writeScenes(recorder.frames, readEvents(eventsFile), outDir)) {
      console.log(`wrote ${line}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
