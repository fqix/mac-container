// End-to-end tests: drive the real commands against the real container service.
// Every resource created here uses a unique e2e- prefix and is removed afterwards.
// Prune commands are intentionally not exercised because they would touch the user's own resources.
import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import * as vscode from 'vscode';

import { composeProjectName } from '../../src/services/compose';
import { recreateContainer } from '../../src/panels/editPanel';
import type { ExtensionApi } from '../../src/extension';
import { parseJson } from '../../src/utils/parse';
import type { ResourceProvider, TreeNode } from '../../src/views/base';
import { ResourceNode } from '../../src/views/base';

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const IMAGE = 'docker.io/library/alpine:latest';
const suffix = Date.now().toString(36);
const names = {
  container: `e2e-${suffix}`,
  volume: `e2e-vol-${suffix}`,
  network: `e2e-net-${suffix}`,
  tag: `e2e-tag-${suffix}:v1`,
  build: `e2e-build-${suffix}:latest`,
  project: `e2e-proj-${suffix}`,
  edit: `e2e-edit-${suffix}`,
  editVolume: `e2e-editvol-${suffix}`,
  ssh: `e2e-ssh-${suffix}`,
  sshBare: `e2e-sshbare-${suffix}`,
};

/** Containers named by the extension, removed in the after hook if a test fails half way */
const generatedNames: string[] = [];

type Restore = () => void;
const restores: Restore[] = [];

/** Replaces a vscode.window function for the rest of the current test */
function stub<K extends keyof typeof vscode.window>(key: K, impl: (...args: any[]) => unknown): void {
  const target = vscode.window as any;
  const original = target[key];
  target[key] = impl;
  restores.push(() => {
    target[key] = original;
  });
}

/** The e2e host runs with --disable-extensions, so pretend Remote - SSH is installed */
function stubRemoteSshExtension(): void {
  const original = Object.getOwnPropertyDescriptor(vscode.extensions, 'all')!;
  const fake = { id: 'ms-vscode-remote.remote-ssh' } as vscode.Extension<unknown>;
  Object.defineProperty(vscode.extensions, 'all', { configurable: true, get: () => [...original.get!.call(vscode.extensions), fake] });
  restores.push(() => Object.defineProperty(vscode.extensions, 'all', original));
}

/** Records vscode.openFolder calls instead of opening a new window */
function captureOpenFolder(): vscode.Uri[] {
  const opened: vscode.Uri[] = [];
  const commands = vscode.commands as any;
  const original = commands.executeCommand;
  commands.executeCommand = (id: string, ...args: unknown[]) => {
    if (id === 'vscode.openFolder') {
      opened.push(args[0] as vscode.Uri);
      return Promise.resolve();
    }
    return original.call(vscode.commands, id, ...args);
  };
  restores.push(() => {
    commands.executeCommand = original;
  });
  return opened;
}

/** Answers input boxes in order; fails the test if more are opened than expected */
function answerInputs(...answers: string[]): void {
  const queue = [...answers];
  stub('showInputBox', async () => {
    assert.ok(queue.length, 'unexpected input box');
    return queue.shift();
  });
}

/** Confirms every modal warning by picking its action button */
function confirmAll(): string[] {
  const seen: string[] = [];
  stub('showWarningMessage', async (message: string, _options: unknown, action: string) => {
    seen.push(message);
    return action;
  });
  return seen;
}

/** Resource nodes of a view; compose groups are expanded so their containers are included */
async function children<T>(provider: ResourceProvider<T>): Promise<ResourceNode<T>[]> {
  const result: ResourceNode<T>[] = [];
  for (const node of await provider.getChildren()) {
    if (node.contextValue === 'composeProject') {
      result.push(...((await provider.getChildren(node)) as ResourceNode<T>[]));
    } else {
      // MessageNode carries an error instead of a resource
      assert.ok('resource' in node, `view reported an error: ${String(node.label)}`);
      result.push(node as ResourceNode<T>);
    }
  }
  return result;
}

/** Labels of the child nodes, e.g. the Volumes / Ports sections of a container */
async function childLabels<T>(provider: ResourceProvider<T>, node: TreeNode): Promise<string[]> {
  return (await provider.getChildren(node)).map((n) => String(n.label));
}

function webviewTabOpen(viewType: string, title: string): boolean {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(viewType) && t.label === title);
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe('Apple Container e2e', function () {
  let api: ExtensionApi;

  before(async () => {
    const extension = vscode.extensions.getExtension<ExtensionApi | undefined>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded`);
    const exported = await extension.activate();
    assert.ok(exported, 'activate() returned no API (not an Apple silicon Mac?)');
    api = exported;
    const state = await api.monitor.check();
    assert.strictEqual(state.kind, 'running', 'the container system service must be running for e2e tests');
    // Make sure the base image is present without depending on the pull command
    const images = await api.cli.listImages();
    if (!images.some((i) => i.reference === IMAGE)) {
      await api.cli.run(['image', 'pull', IMAGE], { timeoutMs: 10 * 60_000 });
    }
  });

  // Commands report failures through showErrorMessage instead of throwing, so surface them here
  let errors: string[] = [];
  beforeEach(() => {
    errors = [];
    stub('showErrorMessage', async (message: string) => {
      errors.push(message);
      return undefined;
    });
  });

  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
    assert.deepStrictEqual(errors, [], 'commands reported errors');
  });

  after(async () => {
    // Best-effort cleanup in case a test failed half way
    const ignore = () => undefined;
    await api?.cli
      .run(['delete', '--force', ...generatedNames, names.ssh, names.sshBare, names.container, `${names.container}-run`, `${names.project}-web`, `${names.project}-worker`, names.edit])
      .catch(ignore);
    await api?.cli.run(['volume', 'delete', names.editVolume]).catch(ignore);
    const snapshots = (await api?.cli.listImages().catch(() => [])) ?? [];
    for (const image of snapshots.filter((i) => i.reference.includes(`${names.edit}-snapshot`))) {
      await api.cli.run(['image', 'delete', image.reference]).catch(ignore);
    }
    await api?.cli.run(['volume', 'delete', names.volume]).catch(ignore);
    await api?.cli.run(['network', 'delete', names.network]).catch(ignore);
    await api?.cli.run(['image', 'delete', names.tag, names.build]).catch(ignore);
  });

  it('registers every command declared in package.json', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const declared: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepStrictEqual(
      declared.filter((c) => !registered.has(c)),
      [],
    );
  });

  it('lists the built-in network and existing images', async () => {
    const networks = await children(api.views.networks);
    const builtin = networks.find((n) => n.resource.id === 'default');
    assert.ok(builtin, 'default network missing');
    assert.strictEqual(builtin.contextValue, 'network.builtin');

    const images = await children(api.views.images);
    assert.ok(images.some((n) => n.resource.reference === IMAGE));
  });

  it('runs a container from an image', async () => {
    const image = (await children(api.views.images)).find((n) => n.resource.reference === IMAGE)!;
    // Container name, published ports, then no script. alpine's default command exits at once, so only check it was created.
    answerInputs(`${names.container}-run`, '18099:80', '');
    await vscode.commands.executeCommand('appleContainer.image.run', image);
    const created = (await api.cli.listContainers()).find((c) => c.id === `${names.container}-run`);
    assert.ok(created, 'container was not created');
    assert.strictEqual(created.image, IMAGE);
    assert.deepStrictEqual(created.ports, ['18099->80/tcp']);
    await api.cli.run(['delete', '--force', created.id]);
  });

  it('runs a custom script in a container with a generated name', async () => {
    const image = (await children(api.views.images)).find((n) => n.resource.reference === IMAGE)!;
    const before = new Set((await api.cli.listContainers()).map((c) => c.id));
    // Empty name: the extension generates a Docker-style one instead of the CLI's UUID
    answerInputs('', '', 'echo scripted > /tmp/out && exec sleep 3600');
    await vscode.commands.executeCommand('appleContainer.image.run', image);
    const created = (await api.cli.listContainers()).filter((c) => !before.has(c.id));
    assert.strictEqual(created.length, 1, 'expected one new container');
    const [container] = created;
    generatedNames.push(container.id);
    assert.match(container.id, /^[a-z]+_[a-z]+\d*$/);
    assert.strictEqual(container.state, 'running', 'the script keeps the container running');
    assert.strictEqual((await api.cli.run(['exec', container.id, 'cat', '/tmp/out'])).trim(), 'scripted');
    await api.cli.run(['delete', '--force', container.id]);
  });

  it('stops, starts, inspects and deletes a container', async () => {
    await api.cli.run(['run', '--detach', '--name', names.container, IMAGE, 'sleep', '3600'], { timeoutMs: 120_000 });
    const findContainer = async () => (await children(api.views.containers)).find((n) => n.resource.id === names.container);
    let node = await waitFor('container to run', async () => {
      const n = await findContainer();
      return n?.contextValue === 'container.running' ? n : undefined;
    });
    assert.ok(node.resource.ipv4, 'running container should have an IP address');

    await vscode.commands.executeCommand('appleContainer.container.stop', node);
    node = await waitFor('container to stop', async () => {
      const n = await findContainer();
      return n?.contextValue === 'container.stopped' ? n : undefined;
    });

    await vscode.commands.executeCommand('appleContainer.container.start', node);
    node = await waitFor('container to start again', async () => {
      const n = await findContainer();
      return n?.contextValue === 'container.running' ? n : undefined;
    });

    // Inspect opens a read-only JSON document
    await vscode.commands.executeCommand('appleContainer.container.inspect', node);
    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc, 'inspect did not open a document');
    assert.strictEqual(doc.uri.scheme, 'apple-container');
    assert.strictEqual(doc.languageId, 'json');
    assert.strictEqual(JSON.parse(doc.getText())[0].configuration.id, names.container);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    await vscode.commands.executeCommand('appleContainer.container.copyId', node);
    assert.strictEqual(await vscode.env.clipboard.readText(), names.container);

    const prompts = confirmAll();
    await vscode.commands.executeCommand('appleContainer.container.delete', node);
    assert.strictEqual(prompts.length, 1, 'delete must ask for confirmation');
    await waitFor('container to be deleted', async () => ((await findContainer()) ? undefined : true));
  });

  it('groups compose containers and shows Volumes / Ports only when present', async () => {
    const label = (service: string) => ['--label', `com.docker.compose.project=${names.project}`, '--label', `com.docker.compose.service=${service}`];
    await api.cli.run(['volume', 'create', names.editVolume]);
    await api.cli.run(
      ['run', '--detach', '--name', `${names.project}-web`, ...label('web'), '--publish', '18097:80', '--volume', `${names.editVolume}:/data`, IMAGE, 'sleep', '3600'],
      { timeoutMs: 120_000 },
    );
    await api.cli.run(['run', '--detach', '--name', `${names.project}-worker`, ...label('worker'), IMAGE, 'sleep', '3600'], { timeoutMs: 120_000 });

    const roots = await api.views.containers.getChildren();
    const group = roots.find((n) => n.id === `compose:${names.project}`);
    assert.ok(group, 'compose group missing');
    assert.strictEqual(group.contextValue, 'composeProject');
    assert.ok(!roots.some((n) => n.id === `container:${names.project}-web`), 'compose container also listed at the top level');

    const members = await api.views.containers.getChildren(group);
    assert.deepStrictEqual(members.map((n) => n.label), [`${names.project}-web`, `${names.project}-worker`]);
    assert.strictEqual(members[0].contextValue, 'container.running.compose');

    const [web, worker] = members;
    assert.deepStrictEqual(await childLabels(api.views.containers, web), ['Volumes', 'Ports']);
    assert.strictEqual(worker.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.deepStrictEqual(await childLabels(api.views.containers, worker), []);

    const [volumes, ports] = await api.views.containers.getChildren(web);
    const [mount] = await api.views.containers.getChildren(volumes);
    assert.strictEqual(mount.label, '/data');
    assert.strictEqual(mount.contextValue, 'mount.volume');
    const [port] = await api.views.containers.getChildren(ports);
    assert.strictEqual(port.label, '18097->80/tcp');
    await vscode.commands.executeCommand('appleContainer.port.copyUrl', port);
    assert.strictEqual(await vscode.env.clipboard.readText(), 'http://localhost:18097');

    // Group actions
    await vscode.commands.executeCommand('appleContainer.compose.stop', group);
    let refreshed = (await api.views.containers.getChildren()).find((n) => n.id === `compose:${names.project}`)!;
    assert.ok(String(refreshed.description).startsWith('0/2'), `unexpected ${refreshed.description}`);
    await vscode.commands.executeCommand('appleContainer.compose.start', refreshed);
    refreshed = (await api.views.containers.getChildren()).find((n) => n.id === `compose:${names.project}`)!;
    assert.ok(String(refreshed.description).startsWith('2/2'), `unexpected ${refreshed.description}`);

    const prompts = confirmAll();
    await vscode.commands.executeCommand('appleContainer.compose.delete', refreshed);
    assert.strictEqual(prompts.length, 1);
    assert.ok(!(await api.views.containers.getChildren()).some((n) => n.id === `compose:${names.project}`));
  });

  it('runs compose up and down for a workspace compose file', async function () {
    if (!fs.existsSync('/opt/homebrew/bin/container-compose') && !fs.existsSync('/usr/local/bin/container-compose')) {
      this.skip();
    }
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'compose.yml');
    const project = composeProjectName(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)), file.path);
    await vscode.commands.executeCommand('appleContainer.compose.up', file);
    const group = await waitFor('compose project to appear', async () =>
      (await api.views.containers.getChildren()).find((n) => n.id === `compose:${project}`),
    );
    assert.deepStrictEqual((await api.views.containers.getChildren(group)).map((n) => n.contextValue), ['container.running.compose']);

    confirmAll();
    await vscode.commands.executeCommand('appleContainer.compose.down', group);
    // container-compose 1.2.0 `down` stops the containers but does not remove them
    const stopped = await waitFor('compose containers to stop', async () => {
      const g = (await api.views.containers.getChildren()).find((n) => n.id === `compose:${project}`);
      return g && String(g.description).startsWith('0/') ? g : undefined;
    });
    await vscode.commands.executeCommand('appleContainer.compose.delete', stopped);
    assert.ok(!(await api.views.containers.getChildren()).some((n) => n.id === `compose:${project}`));
  });

  it('opens the stats chart and the edit form as webviews', async () => {
    await api.cli.run(['run', '--detach', '--name', names.edit, '--publish', '18098:80', IMAGE, 'sleep', '3600'], { timeoutMs: 120_000 });
    const node = await waitFor('edit container', async () =>
      (await children(api.views.containers)).find((n) => n.resource.id === names.edit),
    );
    assert.strictEqual(node.contextValue, 'container.running');

    await vscode.commands.executeCommand('appleContainer.container.stats', node);
    await waitFor('stats tab', async () => (webviewTabOpen('appleContainer.stats', `Stats: ${names.edit}`) ? true : undefined), 10_000);

    await vscode.commands.executeCommand('appleContainer.container.edit', node);
    await waitFor('edit tab', async () => (webviewTabOpen('appleContainer.edit', `Edit: ${names.edit}`) ? true : undefined), 10_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('recreates a container with new ports and mounts, keeping its filesystem changes', async () => {
    const inspect = async () => (parseJson(await api.cli.inspect('container', [names.edit])) as any[])[0];
    await api.cli.run(['exec', names.edit, 'sh', '-c', 'echo kept > /marker.txt']);

    const snapshot = await recreateContainer(
      api.cli,
      await inspect(),
      {
        ports: [{ hostAddress: '127.0.0.1', hostPort: 18096, containerPort: 8080, proto: 'tcp' }],
        mounts: [{ kind: 'volume', source: names.editVolume, destination: '/data', readOnly: false }],
      },
      true,
    );
    assert.ok(snapshot?.startsWith(`${names.edit}-snapshot:`));

    const after = await inspect();
    assert.strictEqual(after.status.state, 'running');
    assert.deepStrictEqual(
      after.configuration.publishedPorts.map((p: any) => `${p.hostAddress}:${p.hostPort}->${p.containerPort}`),
      ['127.0.0.1:18096->8080'],
    );
    assert.deepStrictEqual(after.configuration.mounts.map((m: any) => [m.destination, m.type.volume?.name]), [['/data', names.editVolume]]);
    // Command and arguments survive the recreate
    assert.strictEqual(after.configuration.initProcess.executable, 'sleep');
    assert.deepStrictEqual(after.configuration.initProcess.arguments, ['3600']);
    const marker = await api.cli.run(['exec', names.edit, 'cat', '/marker.txt']);
    assert.strictEqual(marker.trim(), 'kept');
  });

  it('restores the original container when recreating fails', async () => {
    const before = (parseJson(await api.cli.inspect('container', [names.edit])) as any[])[0];
    await assert.rejects(
      recreateContainer(
        api.cli,
        before,
        { ports: [], mounts: [{ kind: 'bind', source: `/nonexistent/${suffix}`, destination: '/broken', readOnly: false }] },
        false,
      ),
      /restored/,
    );
    const after = (parseJson(await api.cli.inspect('container', [names.edit])) as any[])[0];
    assert.strictEqual(after.status.state, 'running');
    assert.deepStrictEqual(after.configuration.publishedPorts, before.configuration.publishedPorts);
    await api.cli.run(['delete', '--force', names.edit]);
  });

  it('opens a container over Remote-SSH and logs in as the detected user', async function () {
    const sshDir = process.env.APPLE_CONTAINER_SSH_DIR;
    const userSshConfig = process.env.E2E_USER_SSH_CONFIG;
    if (!sshDir || !userSshConfig) {
      this.skip();
    }
    this.timeout(10 * 60_000);
    const hostConfig = path.join(sshDir, 'config');
    const alias = `apple-container.${names.ssh}`;
    const ssh = async (command: string) =>
      (await promisify(execFile)('/usr/bin/ssh', ['-F', userSshConfig, '-o', 'BatchMode=yes', alias, command], { timeout: 60_000 })).stdout.trim();
    stubRemoteSshExtension();
    const opened = captureOpenFolder();
    const messages: string[] = [];
    stub('showErrorMessage', async (message: string) => {
      messages.push(message);
      return undefined;
    });
    stub('showWarningMessage', async (message: string) => {
      messages.push(message);
      return undefined;
    });

    // uid 1000 has no passwd entry yet; the extension must map it to a name once the user exists
    await api.cli.run(['run', '--detach', '--name', names.ssh, '--user', '1000', IMAGE, 'sleep', '3600'], { timeoutMs: 120_000 });
    const node = await waitFor('ssh container', async () =>
      (await children(api.views.containers)).find((n) => n.resource.id === names.ssh && n.contextValue === 'container.running'),
    );
    assert.strictEqual(node.resource.user, '1000');

    await api.cli.run(['exec', '-u', '0', names.ssh, 'adduser', '-D', '-u', '1000', 'dev']);
    const hasSshd = () =>
      api.cli.run(['exec', names.ssh, 'test', '-x', '/usr/sbin/sshd']).then(
        () => true,
        () => false,
      );
    assert.ok(!(await hasSshd()), 'alpine should not ship sshd');

    stub('showInputBox', async (options: vscode.InputBoxOptions) => options.value);

    // 1. No sshd or Include: install sshd, prepend the Include and open the user's home in one command
    const unrelated = 'Host example\n  HostName example.com\n';
    const included = `Include "${hostConfig}"\n${unrelated}`;
    fs.writeFileSync(userSshConfig, unrelated);
    await vscode.commands.executeCommand('appleContainer.container.openRemoteSsh', node);
    assert.ok(await hasSshd(), 'openssh-server was not installed');
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(fs.readFileSync(userSshConfig, 'utf8'), included);
    assert.match(fs.readFileSync(hostConfig, 'utf8'), new RegExp(`^Host ${alias.replace(/\./g, '\\.')}$`, 'm'));
    assert.strictEqual(opened[0].scheme, 'vscode-remote');
    assert.strictEqual(opened[0].authority, `ssh-remote+${alias}`);
    assert.strictEqual(opened[0].path, '/home/dev');
    assert.strictEqual(await ssh('id -un; echo $HOME'), 'dev\n/home/dev');

    // 2. Reopening preserves the complete user config, without adding a duplicate Include
    await vscode.commands.executeCommand('appleContainer.container.openRemoteSsh', node);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(opened.length, 2);
    assert.strictEqual(opened[1].path, '/home/dev');
    assert.strictEqual(fs.readFileSync(userSshConfig, 'utf8'), included);
    assert.strictEqual(await ssh('id -un'), 'dev');

    // 3. A missing custom SSH config is created automatically inside the test's temporary directory
    fs.unlinkSync(userSshConfig);
    await vscode.commands.executeCommand('appleContainer.container.openRemoteSsh', node);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(opened.length, 3);
    assert.strictEqual(opened[2].path, '/home/dev');
    assert.strictEqual(fs.readFileSync(userSshConfig, 'utf8'), `Include "${hostConfig}"\n`);
    assert.strictEqual(await ssh('id -un'), 'dev');

    // 4. The sshUser setting overrides the detected user
    const config = vscode.workspace.getConfiguration('appleContainer');
    await config.update('sshUser', 'root', vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('appleContainer.container.openRemoteSsh', node);
      assert.deepStrictEqual(messages, []);
      assert.strictEqual(opened.length, 4);
      assert.strictEqual(opened[3]?.path, '/root');
      assert.strictEqual(await ssh('id -un'), 'root');
    } finally {
      await config.update('sshUser', undefined, vscode.ConfigurationTarget.Global);
    }
    await api.cli.run(['delete', '--force', names.ssh]);
  });

  it('explains how to install sshd when the image has no package manager', async function () {
    this.timeout(5 * 60_000);
    stubRemoteSshExtension();
    const opened = captureOpenFolder();
    const messages: string[] = [];
    stub('showErrorMessage', async (message: string) => {
      messages.push(message);
      return undefined;
    });
    // busybox has a shell but no package manager
    await api.cli.run(['run', '--detach', '--name', names.sshBare, 'docker.io/library/busybox:latest', 'sleep', '3600'], { timeoutMs: 5 * 60_000 });
    const node = await waitFor('busybox container', async () =>
      (await children(api.views.containers)).find((n) => n.resource.id === names.sshBare && n.contextValue === 'container.running'),
    );
    await vscode.commands.executeCommand('appleContainer.container.openRemoteSsh', node);
    assert.strictEqual(messages.length, 1, JSON.stringify(messages));
    assert.ok(messages[0].includes('openssh-server'), messages[0]);
    assert.strictEqual(opened.length, 0);
    await api.cli.run(['delete', '--force', names.sshBare]);
  });

  it('does not delete when the confirmation is dismissed', async () => {
    answerInputs(names.volume, '');
    await vscode.commands.executeCommand('appleContainer.volume.create');
    const volume = (await children(api.views.volumes)).find((n) => n.resource.name === names.volume);
    assert.ok(volume, 'volume was not created');

    stub('showWarningMessage', async () => undefined);
    await vscode.commands.executeCommand('appleContainer.volume.delete', volume);
    assert.ok((await api.cli.listVolumes()).some((v) => v.name === names.volume), 'volume deleted without confirmation');
  });

  it('creates and deletes a volume with a size', async () => {
    await api.cli.run(['volume', 'delete', names.volume]).catch(() => undefined);
    answerInputs(names.volume, '1G');
    await vscode.commands.executeCommand('appleContainer.volume.create');
    const volume = (await children(api.views.volumes)).find((n) => n.resource.name === names.volume);
    assert.ok(volume, 'volume was not created');
    assert.strictEqual(volume.resource.sizeBytes, 1024 ** 3);

    confirmAll();
    await vscode.commands.executeCommand('appleContainer.volume.delete', volume);
    assert.ok(!(await api.cli.listVolumes()).some((v) => v.name === names.volume));
  });

  it('creates and deletes a network', async () => {
    // Name, then subnet (left empty)
    answerInputs(names.network, '');
    await vscode.commands.executeCommand('appleContainer.network.create');
    const network = (await children(api.views.networks)).find((n) => n.resource.id === names.network);
    assert.ok(network, 'network was not created');
    assert.strictEqual(network.contextValue, 'network');

    confirmAll();
    await vscode.commands.executeCommand('appleContainer.network.delete', network);
    assert.ok(!(await api.cli.listNetworks()).some((n) => n.id === names.network));
  });

  it('never deletes the built-in network', async () => {
    const builtin = (await children(api.views.networks)).find((n) => n.resource.id === 'default')!;
    const prompts = confirmAll();
    await vscode.commands.executeCommand('appleContainer.network.delete', builtin);
    assert.strictEqual(prompts.length, 0);
    assert.ok((await api.cli.listNetworks()).some((n) => n.id === 'default'));
  });

  it('tags and deletes an image', async () => {
    const image = (await children(api.views.images)).find((n) => n.resource.reference === IMAGE)!;
    answerInputs(names.tag);
    await vscode.commands.executeCommand('appleContainer.image.tag', image);
    const tagged = await waitFor('tagged image', async () =>
      (await children(api.views.images)).find((n) => n.resource.displayName.endsWith(names.tag)),
    );

    confirmAll();
    await vscode.commands.executeCommand('appleContainer.image.delete', tagged);
    assert.ok(!(await api.cli.listImages()).some((i) => i.reference.endsWith(names.tag)));
    // The source image must survive deleting the tag
    assert.ok((await api.cli.listImages()).some((i) => i.reference === IMAGE));
  });

  it('builds an image from the workspace Dockerfile', async function () {
    if (process.env.E2E_SKIP_BUILD) {
      this.skip();
    }
    this.timeout(15 * 60_000);
    const dockerfile = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'Dockerfile');
    answerInputs(names.build);
    await vscode.commands.executeCommand('appleContainer.image.build', dockerfile);
    const built = (await api.cli.listImages()).find((i) => i.reference.endsWith(names.build));
    assert.ok(built, 'built image not found');
  });

  it('shows registry logins without errors', async () => {
    const registries = await children(api.views.registries);
    for (const node of registries) {
      assert.strictEqual(node.contextValue, 'registry');
      assert.ok(node.resource.hostname);
    }
  });

  it('opens system status and disk usage documents', async () => {
    await vscode.commands.executeCommand('appleContainer.system.status');
    const status = JSON.parse(vscode.window.activeTextEditor!.document.getText());
    assert.strictEqual(status.status, 'running');

    await vscode.commands.executeCommand('appleContainer.system.df');
    const df = JSON.parse(vscode.window.activeTextEditor!.document.getText());
    assert.ok('images' in df && 'containers' in df && 'volumes' in df);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('reports a missing CLI through the welcome view state', async () => {
    const config = vscode.workspace.getConfiguration('appleContainer');
    await config.update('path', '/nonexistent/container', vscode.ConfigurationTarget.Global);
    try {
      const state = await waitFor('cliMissing state', async () => {
        const s = await api.monitor.check();
        return s.kind === 'cliMissing' ? s : undefined;
      });
      assert.strictEqual(state.kind, 'cliMissing');
      assert.deepStrictEqual(await api.views.containers.getChildren(), []);
    } finally {
      await config.update('path', undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor('running state', async () => ((await api.monitor.check()).kind === 'running' ? true : undefined));
  });
});
