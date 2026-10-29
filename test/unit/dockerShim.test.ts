import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  applyRunDefaults,
  diffEvents,
  filterContainers,
  parseFilters,
  parseHelpOptions,
  parseRunDefaults,
  passKnownOptions,
  snapshot,
  splitOptions,
  toDockerContainer,
  toDockerImage,
  translateBuildOptions,
  translateRunOptions,
} from '../../src/dockerShim/translate';
import { devContainerName } from '../../src/services/devcontainer';

// Compiled to out/test/unit, fixtures stay in the source tree
const fixture = (name: string): Record<string, any>[] =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../test/fixtures', name), 'utf8'));

const RUN_HELP = `OPTIONS:
  -e, --env <env>         Set environment variables
  -u, --user <user>       Set the user for the process
  -w, --workdir, --cwd <dir>
                          Set the initial working directory
  --cap-add <cap>         Add a Linux capability
  -d, --detach            Run the container and detach from the process
  --entrypoint <cmd>      Override the entrypoint of the image
  --init                  Run an init process inside the container
  -l, --label <label>     Add a key=value label to the container
  --mount <mount>         Add a mount to the container
  --network <network>     Attach the container to a network
  -p, --publish <spec>    Publish a port from container to host
  --rm, --remove          Remove the container after it stops
  -v, --volume <volume>   Bind mount a volume into the container
`;

describe('docker shim', () => {
  it('parses the options of container --help', () => {
    const options = parseHelpOptions(RUN_HELP);
    assert.strictEqual(options.get('-e'), true);
    assert.strictEqual(options.get('--workdir'), true);
    assert.strictEqual(options.get('--cwd'), true);
    assert.strictEqual(options.get('--init'), false);
    assert.strictEqual(options.get('--remove'), false);
    assert.strictEqual(options.has('--privileged'), false);
  });

  it('splits docker options from positionals', () => {
    assert.deepStrictEqual(
      splitOptions('run', ['--sig-proxy=false', '-a', 'STDOUT', '-it', '-e', 'A=1', '--init', 'alpine', '-c', 'echo hi']),
      {
        options: [
          { name: '--sig-proxy', value: 'false' },
          { name: '-a', value: 'STDOUT' },
          { name: '-i' },
          { name: '-t' },
          { name: '-e', value: 'A=1' },
          { name: '--init' },
        ],
        rest: ['alpine', '-c', 'echo hi'],
      },
    );
    // -a is a boolean for ps but takes a value for run
    assert.deepStrictEqual(splitOptions('ps', ['-q', '-a', '--filter', 'label=x=y']).options, [
      { name: '-q' },
      { name: '-a' },
      { name: '--filter', value: 'label=x=y' },
    ]);
    assert.deepStrictEqual(splitOptions('stop', ['-t', '0', 'c1']), { options: [{ name: '-t', value: '0' }], rest: ['c1'] });
    assert.deepStrictEqual(splitOptions('exec', ['-i', '-u', 'dev', 'c1', 'sh', '-l']).rest, ['c1', 'sh', '-l']);
  });

  it('translates run options, dropping what Apple container cannot do', () => {
    const exists = (p: string) => p === '/Users/dev/src';
    const { options } = splitOptions('run', [
      '--sig-proxy=false', '-a', 'STDOUT', '-a', 'STDERR',
      '--mount', 'type=bind,source=/Users/dev/src,target=/workspaces/src,consistency=cached',
      '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '-l', 'devcontainer.local_folder=/Users/dev/src',
      '-l', 'devcontainer.config_file=/Users/dev/src/.devcontainer/devcontainer.json',
      '-e', 'FOO=bar', '-u', 'dev',
      '--privileged', '--ipc=host', '--volume=/dev:/dev', '-v', 'cache:/cache', '--network', 'host',
      '--security-opt', 'seccomp=unconfined', '--cap-add', 'SYS_PTRACE', '--init',
      '--entrypoint', '/bin/sh',
      'alpine',
    ]);
    const { args, warnings } = translateRunOptions(options, parseHelpOptions(RUN_HELP), exists);
    assert.match(args[args.length - 1], /^devc-src-[0-9a-f]{8}$/);
    assert.deepStrictEqual(args, [
      '--mount', 'type=bind,source=/Users/dev/src,target=/workspaces/src',
      '-l', 'devcontainer.local_folder=/Users/dev/src',
      '-l', 'devcontainer.config_file=/Users/dev/src/.devcontainer/devcontainer.json',
      '-e', 'FOO=bar', '-u', 'dev',
      '--cap-add', 'ALL',
      '--volume', 'cache:/cache',
      '--cap-add', 'SYS_PTRACE', '--init',
      '--entrypoint', '/bin/sh',
      '--name', devContainerName('/Users/dev/src', '/Users/dev/src/.devcontainer/devcontainer.json'),
    ]);
    assert.strictEqual(warnings.length, 6);
    assert.match(warnings.join('\n'), /docker\.sock/);
    assert.match(warnings.join('\n'), /--ipc host/);
    assert.match(warnings.join('\n'), /\/dev is not available/);
    assert.match(warnings.join('\n'), /--network host/);
    assert.match(warnings.join('\n'), /--security-opt seccomp=unconfined/);
  });

  it('adds default resources the run does not set itself', () => {
    const defaults = parseRunDefaults('["--cpus","8","--memory","4G"]');
    assert.deepStrictEqual(applyRunDefaults(['-e', 'A=1'], defaults), ['-e', 'A=1', '--cpus', '8', '--memory', '4G']);
    // runArgs such as --memory=16g or -c 2 win over the defaults
    assert.deepStrictEqual(applyRunDefaults(['--memory', '16g', '-c', '2'], defaults), ['--memory', '16g', '-c', '2']);
    assert.deepStrictEqual(parseRunDefaults(undefined), []);
    assert.deepStrictEqual(parseRunDefaults('not json'), []);
    assert.deepStrictEqual(parseRunDefaults('[1]'), []);
  });

  it('translates build and exec options', () => {
    const buildHelp = parseHelpOptions('  -f, --file <path>\n  -t, --tag <name>\n  --build-arg <key=val>\n  --target <stage>\n  --no-cache\n');
    const build = splitOptions('build', ['-f', 'Dockerfile', '-t', 'img', '--load', '--cache-from', 'x', '--build-arg', 'A=1', '--target', 't', '/ctx']);
    assert.deepStrictEqual(translateBuildOptions(build.options, buildHelp), {
      args: ['-f', 'Dockerfile', '-t', 'img', '--build-arg', 'A=1', '--target', 't'],
      warnings: ['ignoring --cache-from x: not supported by Apple container'],
    });
    assert.deepStrictEqual(build.rest, ['/ctx']);
    const execHelp = parseHelpOptions('  -i, --interactive\n  -t, --tty\n  -u, --user <user>\n  -e, --env <env>\n  -w, --workdir <dir>\n');
    const exec = splitOptions('exec', ['-i', '-u', 'root', '-e', 'A=b c', '-w', '/w', 'c1', 'sh']);
    assert.deepStrictEqual(passKnownOptions(exec.options, execHelp).args, ['-i', '-u', 'root', '-e', 'A=b c', '-w', '/w']);
  });

  it('converts container inspect output to the docker shape', () => {
    const items = fixture('containers.json');
    const running = toDockerContainer(items.find((c) => c.id === 'ccdev-test')!);
    assert.strictEqual(running.Id, 'ccdev-test');
    assert.strictEqual(running.State.Status, 'running');
    assert.strictEqual(running.State.Running, true);
    assert.strictEqual(running.Config.User, '');
    assert.strictEqual(running.Config.Image, 'docker.io/library/alpine:latest');
    assert.ok(Array.isArray(running.Config.Env));
    assert.deepStrictEqual(running.Mounts.map((m: any) => [m.Type, m.Name, m.Destination]), [['volume', 'ccdev-vol', '/data']]);
    assert.strictEqual(toDockerContainer(items.find((c) => c.id === 'ccdev-stopped')!).State.Status, 'exited');
    const ports = toDockerContainer(items.find((c) => c.id === 'ccdev-ports')!).NetworkSettings.Ports;
    assert.deepStrictEqual(ports['80/tcp'], [{ HostIp: '0.0.0.0', HostPort: '18080' }]);
  });

  it('converts image inspect output for the host architecture', () => {
    const image = {
      id: 'abc',
      configuration: { name: 'docker.io/library/x:1' },
      variants: [
        { platform: { os: 'linux', architecture: 'amd64' }, config: { config: { User: 'amd' } } },
        { platform: { os: 'linux', architecture: 'arm64', variant: 'v8' }, config: { config: { User: 'dev', Labels: { a: 'b' }, Entrypoint: ['/e'] } } },
      ],
    };
    const docker = toDockerImage(image, 'arm64');
    assert.strictEqual(docker.Id, 'sha256:abc');
    assert.strictEqual(docker.Architecture, 'arm64');
    assert.deepStrictEqual(docker.Config, { User: 'dev', Env: null, Labels: { a: 'b' }, Entrypoint: ['/e'], Cmd: null, WorkingDir: '' });
    assert.strictEqual(toDockerImage(image, 'riscv64').Config.User, 'amd');
  });

  it('filters containers like docker ps', () => {
    const items = [
      { id: 'a', configuration: { labels: { 'devcontainer.local_folder': '/w', x: '1' } }, status: { state: 'stopped' } },
      { id: 'b', configuration: { labels: { 'devcontainer.local_folder': '/v' } }, status: { state: 'running' } },
    ];
    const filters = parseFilters(splitOptions('ps', ['--filter', 'label=devcontainer.local_folder=/w', '--filter', 'label=x']).options);
    assert.deepStrictEqual(filterContainers(items, filters, true).map((c) => c.id), ['a']);
    assert.deepStrictEqual(filterContainers(items, filters, false).map((c) => c.id), []);
    assert.deepStrictEqual(filterContainers(items, {}, false).map((c) => c.id), ['b']);
  });

  it('derives start, stop and destroy events from container list snapshots', () => {
    const list = (...states: [string, string, string?][]) =>
      snapshot(states.map(([id, state, startedDate]) => ({ id, configuration: { labels: { app: id } }, status: { state, startedDate } })));
    const since = Date.parse('2026-10-29T10:00:00Z');
    const filters = parseFilters(splitOptions('events', ['--filter', 'event=start', '--filter', 'label=app=new']).options);
    // First poll: only containers started after the events command count
    assert.deepStrictEqual(
      diffEvents(undefined, list(['old', 'running', '2026-10-29T09:00:00Z'], ['new', 'running', '2026-10-29T10:00:01Z']), filters, since).map((e) => e.id),
      ['new'],
    );
    const before = list(['new', 'stopped'], ['gone', 'running']);
    const after = list(['new', 'running']);
    assert.deepStrictEqual(diffEvents(before, after, filters, since).map((e) => [e.status, e.id, e.Actor.Attributes.app]), [['start', 'new', 'new']]);
    assert.deepStrictEqual(diffEvents(before, after, { event: ['destroy'] }, since).map((e) => e.id), ['gone']);
  });
});
