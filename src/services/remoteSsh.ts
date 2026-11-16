// Remote-SSH support: ssh reaches a container through `ProxyCommand container exec -i <id> sshd -i`, and a pod of a
// `container cluster` through `ProxyCommand kubectl exec -i <pod> -- sshd -i`, so no IP, published port or long-running
// sshd is needed. Everything here is free of the vscode API for unit tests.

import {execFile} from 'child_process';
import {mkdir, readFile, writeFile, chmod, access, realpath} from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {parseEnvOutput, sessionEnvironment} from '../utils/env';
import type {ContainerCli} from './cli';
import {kubectlArgs, KubeTarget, runProcess} from './kubectl';

const DEFAULT_SSH_DIR = path.join(os.homedir(), '.ssh', 'apple-container');
/** APPLE_CONTAINER_SSH_DIR lets the e2e tests keep everything out of the real ~/.ssh */
export const SSH_DIR = process.env.APPLE_CONTAINER_SSH_DIR || DEFAULT_SSH_DIR;
export const CONFIG_FILE = path.join(SSH_DIR, 'config');
export const KEY_FILE = path.join(SSH_DIR, 'id_ed25519');
/** Line added to the top of the user's SSH config, kept with ~ so it reads the same on every Mac. */
export const INCLUDE_LINE =
  SSH_DIR === DEFAULT_SSH_DIR
    ? 'Include ~/.ssh/apple-container/config'
    : `Include "${CONFIG_FILE}"`;
export const DEFAULT_SSHD = '/usr/sbin/sshd';

/** Exit code of the prepare script when the image has no sshd */
const EXIT_NO_SSHD = 3;
const EXIT_NO_USER = 4;
const EXIT_NO_PACKAGE_MANAGER = 5;

export class SshdMissingError extends Error {
  constructor(readonly containerId: string) {
    super(`sshd not found in container ${containerId}`);
    this.name = 'SshdMissingError';
  }
}

export class NoPackageManagerError extends Error {
  constructor(readonly containerId: string) {
    super(`no supported package manager in container ${containerId}`);
    this.name = 'NoPackageManagerError';
  }
}

export class SshUserMissingError extends Error {
  constructor(
    readonly containerId: string,
    readonly user: string,
  ) {
    super(`user ${user} not found in container ${containerId}`);
    this.name = 'SshUserMissingError';
  }
}

/** ssh matches Host patterns case-insensitively, but the URI authority is lowercased by some hosts, so keep the alias lowercase */
export function hostAlias(containerId: string): string {
  return `apple-container.${containerId.toLowerCase()}`;
}

/** The container whose Remote-SSH host a window is connected to, from the authority of its workspace folder */
export function containerOfAuthority(
  authority: string,
  containerIds: string[],
): string | undefined {
  const prefix = 'ssh-remote+';
  if (!authority.toLowerCase().startsWith(prefix)) {
    return undefined;
  }
  const host = authority.slice(prefix.length).toLowerCase();
  return containerIds.find(id => hostAlias(id) === host);
}

/**
 * Where Remote-SSH runs its setup and sshd: a container through `container exec`, or one container of a pod through
 * `kubectl exec`. `exec` builds the arguments for `executable()`, `run` runs them and rejects with an error that has
 * the exit code and stderr.
 */
export interface ExecTarget {
  /** For messages: the container id or namespace/pod */
  name: string;
  /** Host of the managed SSH config */
  alias: string;
  executable(): Promise<string>;
  /**
   * Arguments that run `argv` in the target: with stdin when `stdin`, as uid 0 when `root`, or as `user`. A pod cannot
   * switch users and runs as its own (see switchesUser).
   */
  exec(
    argv: string[],
    options?: {stdin?: boolean; root?: boolean; user?: string},
  ): string[];
  /** Whether exec honours root and user: `kubectl exec` has no user option */
  switchesUser: boolean;
  run(
    args: string[],
    options?: {input?: string; timeoutMs?: number},
  ): Promise<string>;
}

/** `container exec` arguments running argv in container `id` */
function containerExec(
  id: string,
  argv: string[],
  options: {stdin?: boolean; root?: boolean; user?: string} = {},
): string[] {
  return [
    'exec',
    ...(options.stdin ? ['-i'] : []),
    ...(options.root ? ['-u', '0'] : options.user ? ['-u', options.user] : []),
    id,
    ...argv,
  ];
}

export function containerTarget(cli: ContainerCli, id: string): ExecTarget {
  return {
    name: id,
    alias: hostAlias(id),
    executable: () => cli.executable(),
    exec: (argv, options) => containerExec(id, argv, options),
    switchesUser: true,
    run: (args, options) => cli.run(args, options),
  };
}

/** One container of a pod in a cluster of `container cluster` */
export interface PodRef {
  cluster: string;
  namespace: string;
  pod: string;
  container: string;
}

/**
 * Host of a pod's container, short since Remote-SSH shows it in the window: pod.<pod>, plus .<container> for a pod with
 * several containers. When `taken` says another pod already has it (same name in another namespace or cluster), the
 * namespace and cluster are added. Lowercase like hostAlias.
 */
export function podHostAlias(
  ref: PodRef,
  options: {multiContainer?: boolean; taken?: (alias: string) => boolean} = {},
): string {
  const short = [
    'pod',
    ref.pod,
    ...(options.multiContainer ? [ref.container] : []),
  ]
    .join('.')
    .toLowerCase();
  return options.taken?.(short)
    ? `${short}.${ref.namespace}.${ref.cluster}`.toLowerCase()
    : short;
}

/** `alias` is the pod's host, from podHostAlias */
export function podTarget(
  kubectl: string,
  kube: KubeTarget,
  ref: PodRef,
  alias: string,
): ExecTarget {
  return {
    name: `${ref.namespace}/${ref.pod}`,
    alias,
    executable: async () => kubectl,
    exec: (argv, options = {}) =>
      kubectlArgs(kube, [
        'exec',
        ...(options.stdin ? ['-i'] : []),
        '--namespace',
        ref.namespace,
        ref.pod,
        '--container',
        ref.container,
        '--',
        ...argv,
      ]),
    switchesUser: false,
    run: (args, options) => runProcess(kubectl, args, options),
  };
}

/** Quotes an argument for ProxyCommand, which ssh runs with /bin/sh after expanding % tokens */
function proxyArg(arg: string): string {
  const escaped = arg.replace(/%/g, '%%');
  return /^[\w@%+=:,./-]+$/.test(escaped)
    ? escaped
    : `"${escaped.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * sshd in inetd mode on the connection's stdin/stdout, as root, with key login only. `sshdArgs` go before the options,
 * e.g. podSshdArgs.
 */
export function proxyCommand(
  executable: string,
  exec: ExecTarget['exec'],
  sshd: string,
  sshdArgs: string[] = [],
): string {
  const argv = exec(
    [
      sshd,
      '-i',
      ...sshdArgs,
      '-o',
      'PermitRootLogin=prohibit-password',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'AuthorizedKeysFile=.ssh/authorized_keys',
      '-o',
      'PermitUserEnvironment=yes',
    ],
    {stdin: true, root: true},
  );
  return [`"${executable.replace(/%/g, '%%')}"`, ...argv.map(proxyArg)].join(
    ' ',
  );
}

/**
 * A ProxyCommand that first runs `executable before...` (output discarded, failure ignored), then `command`. ssh starts
 * ProxyCommand with `exec`, so the sequence runs in its own shell.
 */
export function withPrelude(
  executable: string,
  before: string[],
  command: string,
): string {
  const first = [
    `"${executable.replace(/%/g, '%%')}"`,
    ...before.map(proxyArg),
  ];
  const script = `${first.join(' ')} >/dev/null 2>&1; exec ${command}`;
  return `/bin/sh -c '${script.replace(/'/g, `'\\''`)}'`;
}

/**
 * Over `kubectl exec`, sshd -i logging to syslog (pods have no /dev/log) exits with 255 during key exchange
 * (OpenSSH 10.2 in an ubuntu pod), while logging to stderr or a file works; /dev/null keeps the connection quiet.
 */
export const POD_SSHD_ARGS = ['-E', '/dev/null'];

export interface SshHost {
  id: string;
  sshd: string;
  user: string;
}

/** A host block of the managed config */
export interface SshEntry {
  alias: string;
  hostName: string;
  user: string;
  proxyCommand: string;
}

/**
 * Renders the whole managed ssh config; it is regenerated on every open so removed containers disappear. `extra`
 * holds the hosts of pods.
 */
export function renderConfig(
  hosts: SshHost[],
  cliPath: string,
  keyFile = KEY_FILE,
  extra: SshEntry[] = [],
): string {
  const lines = [
    '# Generated by the Apple Container Tools extension. Changes will be overwritten.',
    '',
  ];
  const entries: SshEntry[] = [
    ...hosts.map(host => ({
      alias: hostAlias(host.id),
      hostName: host.id,
      user: host.user,
      proxyCommand: proxyCommand(
        cliPath,
        (argv, options) => containerExec(host.id, argv, options),
        host.sshd,
      ),
    })),
    ...extra,
  ];
  for (const entry of entries) {
    lines.push(
      `Host ${entry.alias}`,
      `  HostName ${entry.hostName}`,
      `  User ${entry.user}`,
      `  IdentityFile "${keyFile}"`,
      '  IdentitiesOnly yes',
      // Host keys change whenever the container is recreated, and the transport is a local exec anyway
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      '  LogLevel ERROR',
      `  ProxyCommand ${entry.proxyCommand}`,
      '',
    );
  }
  return lines.join('\n');
}

/** Splits the arguments of an ssh config line, honouring double quotes */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (match[2]?.startsWith('#')) {
      break;
    }
    args.push(match[1] ?? match[2]);
  }
  return args;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

/** Whether the managed config is included globally, before any Host or Match block. */
export function isIncluded(
  sshConfig: string,
  home = os.homedir(),
  target = CONFIG_FILE,
): boolean {
  for (const line of sshConfig.split('\n')) {
    if (/^\s*(?:host|match)(?:\s|=)/i.test(line)) {
      break;
    }
    const m = /^\s*include(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(line);
    if (!m) {
      continue;
    }
    for (const arg of splitArgs(m[1])) {
      // Relative paths in a user config are resolved against ~/.ssh
      const expanded = arg.startsWith('~/')
        ? path.join(home, arg.slice(2))
        : path.isAbsolute(arg)
          ? arg
          : path.join(home, '.ssh', arg);
      if (globToRegExp(expanded).test(target)) {
        return true;
      }
    }
  }
  return false;
}

/** Add the global Include once, preserving existing SSH config contents and permissions. */
export async function ensureUserConfigIncluded(
  userConfig: string,
  target = CONFIG_FILE,
): Promise<void> {
  // A custom Remote-SSH config may already point directly to the managed file.
  // Including that file from itself would exceed ssh's include depth limit.
  if (path.resolve(userConfig) === path.resolve(target)) {
    return;
  }
  try {
    if ((await realpath(userConfig)) === (await realpath(target))) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  let text = '';
  try {
    text = await readFile(userConfig, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (isIncluded(text, os.homedir(), target)) {
    return;
  }
  const include = target === CONFIG_FILE ? INCLUDE_LINE : `Include "${target}"`;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  await mkdir(path.dirname(userConfig), {recursive: true, mode: 0o700});
  await writeFile(userConfig, include + newline + text, {mode: 0o600});
}

export interface PrepareResult {
  sshd: string;
  /** Login name resolved inside the container */
  user: string;
  home: string;
  /** wget or curl answers --version, the check Remote-SSH makes before it uses one */
  downloader: boolean;
  /** Remote-SSH runs its server setup in a bash subshell on Linux and fails with "bash not found" without it */
  bash: boolean;
}

export function parsePrepareOutput(stdout: string): PrepareResult {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) {
      values.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
  }
  return {
    sshd: values.get('sshd') || DEFAULT_SSHD,
    user: values.get('user') || 'root',
    home: values.get('home') || '/',
    downloader: values.get('downloader') !== 'no',
    bash: values.get('bash') !== 'no',
  };
}

/** Packages Remote-SSH needs that the container lacks, installed together to make one package manager run */
export function missingPackages(prepared: PrepareResult): string[] {
  return [
    ...(prepared.bash ? [] : ['bash']),
    ...(prepared.downloader ? [] : ['wget', 'ca-certificates']),
  ];
}

// Runs as root inside the container: finds sshd, creates host keys if the package did not, and authorizes the extension key.
// It never installs packages. $1 is the user spec (name, uid or name:group; empty means root), the public key comes in on stdin.
const PREPARE_SCRIPT = `
user="\${1%%:*}"
if [ -z "$user" ]; then user=0; fi
sshd=$(command -v sshd 2>/dev/null)
if [ -z "$sshd" ] && [ -x /usr/sbin/sshd ]; then sshd=/usr/sbin/sshd; fi
if [ -z "$sshd" ]; then echo "sshd not found" >&2; exit ${EXIT_NO_SSHD}; fi
if ! ls /etc/ssh/ssh_host_*_key >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1; then ssh-keygen -A >/dev/null; fi
mkdir -p /run/sshd 2>/dev/null
entry=$(getent passwd "$user" 2>/dev/null || awk -F: -v u="$user" '$1 == u || $3 == u { print; exit }' /etc/passwd)
if [ -z "$entry" ]; then echo "user $user not found" >&2; exit ${EXIT_NO_USER}; fi
name=$(echo "$entry" | cut -d: -f1)
uid=$(echo "$entry" | cut -d: -f3)
gid=$(echo "$entry" | cut -d: -f4)
home=$(echo "$entry" | cut -d: -f6)
key=$(cat)
# Without PAM, sshd rejects accounts whose password field is "!" (adduser -D and many images); "*" still allows no password login
if [ -w /etc/shadow ]; then sed -i -E "s/^$name:!{1,2}:/$name:*:/" /etc/shadow; fi
set -e
mkdir -p "$home/.ssh"
touch "$home/.ssh/authorized_keys"
grep -qxF "$key" "$home/.ssh/authorized_keys" || echo "$key" >> "$home/.ssh/authorized_keys"
chmod 700 "$home/.ssh"
chmod 600 "$home/.ssh/authorized_keys"
chown -R "$uid:$gid" "$home/.ssh"
echo "sshd=$sshd"
echo "user=$name"
echo "home=$home"
# BusyBox wget fails --version, so Remote-SSH treats it as missing too
if wget --version >/dev/null 2>&1 || curl --version >/dev/null 2>&1; then echo "downloader=yes"; else echo "downloader=no"; fi
if command -v bash >/dev/null 2>&1; then echo "bash=yes"; else echo "bash=no"; fi
`;

/** A pod whose container does not run as root: `kubectl exec` cannot switch to root to set up sshd */
export class PodNotRootError extends Error {
  constructor(
    readonly target: string,
    readonly uid: string,
  ) {
    super(`${target} runs as uid ${uid}, not root`);
    this.name = 'PodNotRootError';
  }
}

/**
 * Sets up sshd login in the target as root and resolves the user spec there, so a uid from the image maps to its
 * login name. A target that cannot switch to root (a pod) must already run as root.
 */
export async function prepareTarget(
  target: ExecTarget,
  user: string,
  publicKey: string,
): Promise<PrepareResult> {
  if (!target.switchesUser) {
    const uid = (await target.run(target.exec(['id', '-u']))).trim();
    if (uid !== '0') {
      throw new PodNotRootError(target.name, uid);
    }
  }
  try {
    const out = await target.run(
      target.exec(['sh', '-c', PREPARE_SCRIPT, 'sh', user], {
        stdin: true,
        root: true,
      }),
      {input: publicKey.trim() + '\n'},
    );
    return parsePrepareOutput(out);
  } catch (error) {
    const {exitCode, stderr} = error as {exitCode?: unknown; stderr?: string};
    if (exitCode === EXIT_NO_SSHD || stderr?.includes('sshd not found')) {
      throw new SshdMissingError(target.name);
    }
    if (exitCode === EXIT_NO_USER || /^user .* not found/m.test(stderr ?? '')) {
      throw new SshUserMissingError(target.name, user);
    }
    throw error;
  }
}

/** Process id of the running install script inside the container, so that it can be stopped */
const INSTALL_PID_FILE = '/tmp/.apple-container-install.pid';

// Installs the packages in $@ with whichever package manager the image has; runs as root
const INSTALL_SCRIPT = `
set -e
echo $$ > ${INSTALL_PID_FILE}
trap 'rm -f ${INSTALL_PID_FILE}' EXIT
if command -v apk >/dev/null 2>&1; then apk add --no-cache "$@"
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "$@"
elif command -v dnf >/dev/null 2>&1; then dnf install -y "$@"
elif command -v microdnf >/dev/null 2>&1; then microdnf install -y "$@"
elif command -v yum >/dev/null 2>&1; then yum install -y "$@"
elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install "$@"
else echo "no package manager" >&2; exit ${EXIT_NO_PACKAGE_MANAGER}
fi
`;

// Stops the install script and the package manager it runs: a stopped `container exec` client leaves them running.
// Walks /proc (PPid in status) since images often have no pkill or ps.
const CANCEL_INSTALL_SCRIPT = `
pid=$(cat ${INSTALL_PID_FILE} 2>/dev/null) || exit 0
stop() {
  for status in $(grep -l "^PPid:[[:space:]]*$1\$" /proc/[0-9]*/status 2>/dev/null); do
    child=\${status#/proc/}
    stop "\${child%/status}"
  done
  kill -TERM "$1" 2>/dev/null
}
stop "$pid"
rm -f ${INSTALL_PID_FILE}
`;

export interface InstallCommand {
  /** The target's exec program: the container CLI or kubectl */
  executable: string;
  /** Its arguments that install the packages */
  args: string[];
  /** What they install, for the terminal's step line */
  packages: string[];
  /** Its arguments that stop the install when the user cancels it */
  cancelArgs: string[];
}

/**
 * Runs the install command where the user can follow the output (a terminal) and resolves with its exit code
 */
export type InstallRunner = (
  command: InstallCommand,
) => Promise<number | undefined>;

export class InstallFailedError extends Error {
  constructor(
    readonly containerId: string,
    readonly packages: string[],
    readonly exitCode: number | undefined,
  ) {
    super(
      `installing ${packages.join(' ')} in ${containerId} exited with code ${exitCode ?? 'unknown'}; its output is in the terminal`,
    );
    this.name = 'InstallFailedError';
  }
}

/** The exec commands that install packages as root with the image's package manager, or stop that */
export async function installCommand(
  target: ExecTarget,
  packages: string[],
): Promise<InstallCommand> {
  return {
    executable: await target.executable(),
    args: target.exec(['sh', '-c', INSTALL_SCRIPT, 'sh', ...packages], {
      root: true,
    }),
    packages,
    cancelArgs: target.exec(['sh', '-c', CANCEL_INSTALL_SCRIPT], {
      root: true,
    }),
  };
}

/** Installs openssh-server inside the target; downloading packages needs network access from it */
export function installSshd(
  target: ExecTarget,
  run: InstallRunner,
): Promise<void> {
  return installPackages(target, ['openssh-server'], run);
}

/**
 * Installs packages inside the container with its package manager, such as those from missingPackages: bash, and
 * wget (GNU, not BusyBox), as when the VS Code server already runs Remote-SSH asks it to delay its shutdown with wget
 * or curl and fails the connection without either; that step has no local fallback.
 * `run` shows the package manager's output, which can take minutes, instead of hiding it behind a progress bar.
 */
export async function installPackages(
  target: ExecTarget,
  packages: string[],
  run: InstallRunner,
): Promise<void> {
  const code = await run(await installCommand(target, packages));
  if (code === EXIT_NO_PACKAGE_MANAGER) {
    throw new NoPackageManagerError(target.name);
  }
  if (code !== 0) {
    throw new InstallFailedError(target.name, packages, code);
  }
}

// Writes stdin to ~/.ssh/environment of the login user ($1); runs as root
const SESSION_ENV_SCRIPT = `
set -e
entry=$(getent passwd "$1" 2>/dev/null || awk -F: -v u="$1" '$1 == u { print; exit }' /etc/passwd)
uid=$(echo "$entry" | cut -d: -f3)
gid=$(echo "$entry" | cut -d: -f4)
home=$(echo "$entry" | cut -d: -f6)
mkdir -p "$home/.ssh"
cat > "$home/.ssh/environment"
chmod 600 "$home/.ssh/environment"
chown "$uid:$gid" "$home/.ssh/environment"
`;

/**
 * SSH sessions do not inherit the container's environment (image ENV, run --env), so it is written to the login user's
 * ~/.ssh/environment together with the extra variables; sshd runs with PermitUserEnvironment=yes to read it.
 */
export async function writeSessionEnvironment(
  target: ExecTarget,
  user: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const containerEnv = parseEnvOutput(await target.run(target.exec(['env'])));
  await target.run(
    target.exec(['sh', '-c', SESSION_ENV_SCRIPT, 'sh', user], {
      stdin: true,
      root: true,
    }),
    {input: sessionEnvironment(containerEnv, extra)},
  );
}

/** Creates the extension's own key pair on first use and returns the public key */
export async function ensureClientKey(): Promise<string> {
  await mkdir(SSH_DIR, {recursive: true, mode: 0o700});
  try {
    await access(KEY_FILE);
  } catch {
    await new Promise<void>((resolve, reject) => {
      execFile(
        '/usr/bin/ssh-keygen',
        [
          '-t',
          'ed25519',
          '-N',
          '',
          '-q',
          '-C',
          'apple-container-vscode',
          '-f',
          KEY_FILE,
        ],
        error =>
          error
            ? reject(
                new Error(`ssh-keygen failed: ${error.message}`, {
                  cause: error,
                }),
              )
            : resolve(),
      );
    });
  }
  return readFile(`${KEY_FILE}.pub`, 'utf8');
}

export async function writeConfig(content: string): Promise<void> {
  await mkdir(SSH_DIR, {recursive: true, mode: 0o700});
  await writeFile(CONFIG_FILE, content, {mode: 0o600});
  // writeFile keeps the mode of an existing file; ssh refuses group/world-writable configs
  await chmod(CONFIG_FILE, 0o600);
}
