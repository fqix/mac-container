// The options shown in the build form, converted to `container build` arguments.
// No vscode dependency. Options follow apple/container 1.6.1 (Sources/ContainerCommands/Build/BuildOptions.swift).

export interface BuildOptions {
  /** Image name and tag */
  tag: string;
  /** Absolute path of the build context directory */
  context: string;
  /** Stage to build; empty builds the last stage */
  target: string;
  /** os/arch such as linux/amd64; empty uses the CLI default (this Mac's architecture or CONTAINER_DEFAULT_PLATFORM) */
  platforms: string[];
  /** KEY=VALUE */
  buildArgs: string[];
  /** id=<key>[,env=<VAR>|,src=<path>]; a bare id=<key> reads the environment variable <key> */
  secrets: string[];
  /** KEY=VALUE */
  labels: string[];
  noCache: boolean;
  /** Pull the base images again even if they are stored locally */
  pull: boolean;
  /** Forward this Mac's SSH agent (--ssh default) */
  ssh: boolean;
}

/** Platforms offered in the form; amd64 is built with Rosetta, or QEMU when the build.rosetta property is off */
export const BUILD_PLATFORMS = ['linux/arm64', 'linux/amd64'];

export function defaultBuildOptions(tag: string, context: string): BuildOptions {
  return { tag, context, target: '', platforms: [], buildArgs: [], secrets: [], labels: [], noCache: false, pull: false, ssh: false };
}

export function buildImageArgs(dockerfile: string, options: BuildOptions): string[] {
  const args = ['build', '--progress', 'plain', '--file', dockerfile, '--tag', options.tag];
  if (options.target) {
    args.push('--target', options.target);
  }
  for (const platform of options.platforms) {
    args.push('--platform', platform);
  }
  for (const arg of options.buildArgs) {
    args.push('--build-arg', arg);
  }
  for (const secret of options.secrets) {
    args.push('--secret', secret);
  }
  for (const label of options.labels) {
    args.push('--label', label);
  }
  if (options.noCache) {
    args.push('--no-cache');
  }
  if (options.pull) {
    args.push('--pull');
  }
  if (options.ssh) {
    args.push('--ssh', 'default');
  }
  args.push(options.context);
  return args;
}

/** Names of the stages declared with `FROM <image> AS <name>`, in order */
export function parseStages(dockerfile: string): string[] {
  const stages: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)\s*$/i.exec(line);
    if (m && !stages.includes(m[1])) {
      stages.push(m[1]);
    }
  }
  return stages;
}

export type BuildProblemReason = 'tag' | 'context' | 'target' | 'keyValue' | 'secretId' | 'secretValue' | 'secretEnv' | 'sshAgent';

export interface BuildProblem {
  section: 'tag' | 'context' | 'target' | 'buildArgs' | 'secrets' | 'labels' | 'ssh';
  /** Zero-based row index within the section */
  index: number;
  reason: BuildProblemReason;
  /** Environment variable that is missing, for secretEnv */
  name?: string;
}

/**
 * Returns the problems found; empty when the options can be built.
 * @param env the environment the CLI runs with: env secrets and --ssh are read from it
 */
export function validateBuildOptions(options: BuildOptions, env: Record<string, string | undefined>): BuildProblem[] {
  const problems: BuildProblem[] = [];
  if (!options.tag || /\s/.test(options.tag)) {
    problems.push({ section: 'tag', index: 0, reason: 'tag' });
  }
  if (!options.context.startsWith('/')) {
    problems.push({ section: 'context', index: 0, reason: 'context' });
  }
  if (/\s/.test(options.target)) {
    problems.push({ section: 'target', index: 0, reason: 'target' });
  }
  const keyValue = (section: 'buildArgs' | 'labels') => (entry: string, index: number) => {
    if (!/^[^=\s]+=/.test(entry)) {
      problems.push({ section, index, reason: 'keyValue' });
    }
  };
  options.buildArgs.forEach(keyValue('buildArgs'));
  options.labels.forEach(keyValue('labels'));
  options.secrets.forEach((entry, index) => {
    // Same parsing as the CLI: id=<key>, then optionally one env= or src= part
    const [first, rest] = splitOnce(entry, ',');
    const id = first.startsWith('id=') ? first.slice(3) : '';
    if (!id || id.includes('=')) {
      problems.push({ section: 'secrets', index, reason: 'secretId' });
      return;
    }
    if (rest === undefined || rest.startsWith('env=')) {
      const name = rest === undefined ? id : rest.slice(4);
      if (env[name] === undefined) {
        problems.push({ section: 'secrets', index, reason: 'secretEnv', name });
      }
    } else if (!rest.startsWith('src=') || rest.length === 4) {
      problems.push({ section: 'secrets', index, reason: 'secretValue' });
    }
  });
  if (options.ssh && !env.SSH_AUTH_SOCK) {
    problems.push({ section: 'ssh', index: 0, reason: 'sshAgent' });
  }
  return problems;
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)];
}

/** Messages exchanged with the build form webview (webview-ui/src/views/BuildForm.tsx) */
export type BuildToWebview =
  | {
      type: 'init';
      /** Dockerfile path shown in the title, relative to the workspace when inside it */
      file: string;
      stages: string[];
      platforms: string[];
      options: BuildOptions;
    }
  | { type: 'contextPicked'; path: string }
  | { type: 'problems'; messages: string[] }
  | { type: 'busy'; busy: boolean };

export type BuildFromWebview =
  | { type: 'ready' }
  | { type: 'pickContext'; current: string }
  | { type: 'build'; options: BuildOptions }
  | { type: 'cancel' };
