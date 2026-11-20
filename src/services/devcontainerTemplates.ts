// Dev Container Templates bundled with the extension (resources/devcontainer-templates, refreshed with
// `npm run update:templates`): the official Templates and Features Apple container can run. A Template is applied
// here the way the Dev Containers CLI applies one (`templates apply` in devcontainers/cli 0.90.0): option defaults,
// ${templateOption:…} replaced in every file, and Features added to devcontainer.json with jsonc edits, which keep
// its comments. No network is needed and there is no vscode dependency.

import {chmod, mkdir, readFile, stat, writeFile} from 'fs/promises';
import * as path from 'path';

import {applyEdits, modify, parse} from 'jsonc-parser';

const OFFICIAL_TEMPLATES = 'ghcr.io/devcontainers/templates/';
const OFFICIAL_FEATURES = 'ghcr.io/devcontainers/features/';

export interface TemplateOption {
  type: 'string' | 'boolean';
  description?: string;
  /** Suggested values; any other value is allowed */
  proposals?: string[];
  /** The only allowed values */
  enum?: string[];
  default?: string;
}

export interface TemplateEntry {
  id: string;
  version: string;
  name: string;
  description?: string;
  documentationURL?: string;
  /** image / dockerfile / dockerCompose */
  type?: string;
  options: Record<string, TemplateOption>;
  /** Files the Template may leave out, such as .github/dependabot.yml or tests/* */
  optionalPaths: string[];
  /** The files it writes, relative to the workspace folder (and to its bundled directory) */
  files: string[];
}

export interface FeatureEntry {
  id: string;
  version: string;
  name: string;
  description?: string;
}

export interface TemplateIndex {
  templates: TemplateEntry[];
  features: FeatureEntry[];
}

type Json = Record<string, any>;

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.map(String) : undefined;

function parseOption(option: Json): TemplateOption {
  return {
    type: option.type === 'boolean' ? 'boolean' : 'string',
    description: option.description,
    proposals: strings(option.proposals),
    enum: strings(option.enum),
    // Booleans are written as strings in most Templates; Template arguments are strings either way
    default: option.default === undefined ? undefined : String(option.default),
  };
}

/** The bundled index.json written by scripts/update-devcontainer-templates.mjs */
export function parseTemplateIndex(data: unknown): TemplateIndex {
  const index = (data ?? {}) as Json;
  const templates: TemplateEntry[] = (
    Array.isArray(index.templates) ? index.templates : []
  )
    .filter(
      (t: Json) => typeof t?.id === 'string' && typeof t.version === 'string',
    )
    .map((t: Json) => ({
      id: t.id,
      version: t.version,
      name: t.name ?? t.id,
      description: t.description,
      documentationURL: t.documentationURL,
      type: t.type,
      options: Object.fromEntries(
        Object.entries((t.options ?? {}) as Json).map(([k, o]) => [
          k,
          parseOption(o as Json),
        ]),
      ),
      optionalPaths: strings(t.optionalPaths) ?? [],
      files: strings(t.files) ?? [],
    }));
  const features: FeatureEntry[] = (
    Array.isArray(index.features) ? index.features : []
  )
    .filter(
      (f: Json) => typeof f?.id === 'string' && typeof f.version === 'string',
    )
    .map((f: Json) => ({
      id: f.id,
      version: f.version,
      name: f.name ?? f.id,
      description: f.description,
    }));
  const byName = (a: {name: string}, b: {name: string}) =>
    a.name.localeCompare(b.name);
  return {templates: templates.sort(byName), features: features.sort(byName)};
}

/** Templates and Features that need a Docker daemon or a GPU, which an Apple container VM does not have */
const DOCKER_TEMPLATES = new Set(
  [
    'docker-in-docker',
    'docker-outside-of-docker',
    // Uses docker-outside-of-docker and mounts the host's Docker socket
    'kubernetes-helm',
    'kubernetes-helm-minikube',
  ].map(name => OFFICIAL_TEMPLATES + name),
);
export const UNSUPPORTED_FEATURES = new Set(
  ['docker-in-docker', 'docker-outside-of-docker', 'nvidia-cuda'].map(
    name => OFFICIAL_FEATURES + name,
  ),
);

export type Incompatibility = 'compose' | 'docker' | 'gpu';

/** Why Apple container cannot run a Template, or undefined when it can */
export function templateIncompatibility(
  template: Pick<TemplateEntry, 'id' | 'type'>,
): Incompatibility | undefined {
  if (template.type === 'dockerCompose') {
    return 'compose';
  }
  return DOCKER_TEMPLATES.has(template.id) ? 'docker' : undefined;
}

export function featureIncompatibility(
  feature: Pick<FeatureEntry, 'id'>,
): Incompatibility | undefined {
  if (!UNSUPPORTED_FEATURES.has(feature.id)) {
    return undefined;
  }
  return feature.id.endsWith('/nvidia-cuda') ? 'gpu' : 'docker';
}

/** Major version tag of a Feature, as devcontainer.json references it: ghcr.io/devcontainers/features/node:1 */
export function featureReference(
  feature: Pick<FeatureEntry, 'id' | 'version'>,
): string {
  return `${feature.id}:${feature.version.split('.')[0]}`;
}

/** Option values: the given ones, else the defaults (as the CLI fills them in) */
export function templateArgs(
  template: Pick<TemplateEntry, 'options'>,
  given: Record<string, string> = {},
): Record<string, string> {
  const args = {...given};
  for (const [name, option] of Object.entries(template.options)) {
    if (args[name] === undefined && option.default) {
      args[name] = option.default;
    }
  }
  return args;
}

/** ${templateOption:name} replaced by its value; an option without one becomes empty, as in the CLI */
export function substituteOptions(
  text: string,
  args: Record<string, string>,
): string {
  return text.replace(
    /\$\{templateOption:\s*(\w+?)\s*\}/g,
    (_, name: string) => args[name] || '',
  );
}

/** Adds Features to devcontainer.json, creating "features" when missing, with jsonc edits that keep comments */
export function addFeatures(
  configText: string,
  features: Pick<FeatureEntry, 'id' | 'version'>[],
): string {
  let text = configText;
  const config = parse(text) as Json | undefined;
  if (features.length && !config?.features) {
    text = applyEdits(
      text,
      modify(text, ['features'], {}, {formattingOptions: {}}),
    );
  }
  for (const feature of features) {
    text = applyEdits(
      text,
      modify(
        text,
        ['features', featureReference(feature)],
        {},
        {
          formattingOptions: {},
        },
      ),
    );
  }
  return text;
}

export type CodingAgent =
  'claude' | 'codex' | 'opencode' | 'kimi' | 'mimo' | 'qwen';

interface CodingAgentInstall {
  id: CodingAgent;
  name: string;
  /** The official install script and the shell its instructions pipe it to */
  url: string;
  shell: 'bash' | 'sh';
  /** Where the script puts the agent, relative to the home directory */
  binDir: string;
}

export const CODING_AGENTS: readonly CodingAgentInstall[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    url: 'https://claude.ai/install.sh',
    shell: 'bash',
    binDir: '.local/bin',
  },
  {
    id: 'codex',
    name: 'Codex',
    url: 'https://chatgpt.com/codex/install.sh',
    shell: 'sh',
    binDir: '.local/bin',
  },
  {
    id: 'opencode',
    name: 'opencode',
    url: 'https://opencode.ai/v2/install',
    shell: 'bash',
    binDir: '.opencode/bin',
  },
  // binDir checked on 2026-11-20 in mcr.microsoft.com/devcontainers/base:ubuntu (arm64, non-root) with the scripts'
  // latest releases then; the scripts install whatever is current, so recheck binDir when one stops being found
  {
    id: 'kimi',
    name: 'Kimi Code',
    url: 'https://code.kimi.com/kimi-code/install.sh',
    shell: 'bash',
    binDir: '.kimi-code/bin',
  },
  {
    id: 'mimo',
    name: 'MiMo Code',
    url: 'https://mimo.xiaomi.com/install',
    shell: 'bash',
    binDir: '.mimocode/bin',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    url: 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh',
    shell: 'bash',
    binDir: '.local/bin',
  },
];

/** The install command as the agent's documentation gives it, for showing */
export function installCommandOf(agent: CodingAgentInstall): string {
  return `curl -fsSL ${agent.url} | ${agent.shell}`;
}

/** Ends each PATH line agentInstallCommand adds */
export const AGENT_PATH_MARKER = '# Added by Apple Container Tools';

/**
 * A postCreateCommand that installs the agents with their official scripts, one after another, then puts their
 * directories on PATH for every shell: the scripts only set it up for some (opencode only in .bashrc, none in zsh).
 *
 * - A script is downloaded before it runs (`script=$(curl …)`), so a failed download counts as a failed install
 *   instead of an empty `| bash` that succeeds. An install that fails does not stop the others; the agents that could
 *   not be installed are named on stderr in the dev container log, and the command still succeeds, since a failing
 *   postCreateCommand would keep the dev container from opening.
 * - Each directory gets its own PATH line, added once per file: a later run with another agent adds only its line.
 *   The lines are single-quoted, so $HOME and $PATH expand when a shell starts.
 * - POSIX only: the string runs with /bin/sh, which is dash on Debian and Ubuntu. The image needs curl and bash, as
 *   the official devcontainers images have.
 */
export function agentInstallCommand(agents: readonly CodingAgent[]): string {
  const chosen = CODING_AGENTS.filter(a => agents.includes(a.id));
  const installs = chosen.map(
    a =>
      `script=$(curl -fsSL ${a.url}) && printf '%s\\n' "$script" | ${a.shell} || failed="$failed, ${a.name}"`,
  );
  const lines = [...new Set(chosen.map(a => a.binDir))].map(
    dir => `export PATH="$HOME/${dir}:$PATH" ${AGENT_PATH_MARKER}`,
  );
  const pathFix =
    'for rc in .bashrc .profile .zshenv; do ' +
    '[ "$rc" = .zshenv ] && ! command -v zsh >/dev/null && continue; ' +
    lines
      .map(
        line =>
          `grep -qsF '${line}' "$HOME/$rc" || printf '%s\\n' '${line}' >> "$HOME/$rc"`,
      )
      .join('; ') +
    '; done';
  const report = `[ -z "$failed" ] || printf 'Could not install:%s\\n' "\${failed#,}" >&2`;
  return ['failed=', ...installs, pathFix, report].join('; ');
}

/** Alpine images lack bash, which the install scripts need */
export function supportsCodingAgents(
  template: Pick<TemplateEntry, 'id'>,
): boolean {
  return template.id !== `${OFFICIAL_TEMPLATES}alpine`;
}

/**
 * Adds a postCreateCommand to devcontainer.json with jsonc edits. A Template's own command is kept: both become
 * entries of the object form, which the Dev Containers CLI runs in parallel.
 */
export function addPostCreateCommand(
  configText: string,
  key: string,
  command: string,
): string {
  const existing = (parse(configText) as Json | undefined)?.postCreateCommand;
  const edit = (keyPath: (string | number)[], value: unknown) =>
    applyEdits(
      configText,
      modify(configText, keyPath, value, {formattingOptions: {}}),
    );
  if (existing === undefined) {
    return edit(['postCreateCommand'], command);
  }
  if (typeof existing === 'string' || Array.isArray(existing)) {
    return edit(['postCreateCommand'], {template: existing, [key]: command});
  }
  return edit(['postCreateCommand', key], command);
}

/** Whether a Template file is one of its optional paths (a file, or `<dir>/*`) */
export function isOptionalPath(
  template: Pick<TemplateEntry, 'optionalPaths'>,
  file: string,
): boolean {
  return template.optionalPaths.some(p =>
    p.endsWith('/*') ? file.startsWith(p.slice(0, -1)) : file === p,
  );
}

/** The files a Template writes; optional ones (such as .github/dependabot.yml) only when asked */
export function templateFiles(
  template: Pick<TemplateEntry, 'files' | 'optionalPaths'>,
  includeOptionalPaths = false,
): string[] {
  return template.files.filter(
    file => includeOptionalPaths || !isOptionalPath(template, file),
  );
}

export interface ApplyOptions {
  /** The Template's bundled directory */
  templateDir: string;
  workspaceFolder: string;
  template: Pick<TemplateEntry, 'files' | 'optionalPaths' | 'options'>;
  /** Option values by option id; missing ones take their defaults */
  args?: Record<string, string>;
  features?: Pick<FeatureEntry, 'id' | 'version'>[];
  /** Coding agents installed by postCreateCommand */
  agents?: readonly CodingAgent[];
  includeOptionalPaths?: boolean;
}

/** Writes the Template into the workspace folder, overwriting its files; resolves the paths written */
export async function applyTemplate(options: ApplyOptions): Promise<string[]> {
  const args = templateArgs(options.template, options.args);
  const features = options.features ?? [];
  const written: string[] = [];
  for (const file of templateFiles(
    options.template,
    options.includeOptionalPaths,
  )) {
    const source = path.join(options.templateDir, ...file.split('/'));
    const target = path.join(options.workspaceFolder, ...file.split('/'));
    let text = substituteOptions(await readFile(source, 'utf8'), args);
    if (path.posix.basename(file) === 'devcontainer.json') {
      text = addFeatures(text, features);
      if (options.agents?.length) {
        text = addPostCreateCommand(
          text,
          'coding-agents',
          agentInstallCommand(options.agents),
        );
      }
    }
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, text);
    // The user's own file: writable whatever the extension's files are, executable when the Template's file is
    await chmod(target, (await stat(source)).mode & 0o111 ? 0o755 : 0o644);
    written.push(target);
  }
  return written;
}

/** Skips the prompts of Add Dev Container Configuration: used by the e2e tests */
export interface DirectTemplate {
  /** Template id without a version, e.g. ghcr.io/devcontainers/templates/ubuntu */
  template: string;
  args?: Record<string, string>;
  /** Feature ids without a version */
  features?: string[];
  agents?: CodingAgent[];
}

/** The command's second argument as a DirectTemplate; from the explorer it is the selection, a list of URIs */
export function asDirectTemplate(value: unknown): DirectTemplate | undefined {
  return typeof (value as DirectTemplate | undefined)?.template === 'string'
    ? (value as DirectTemplate)
    : undefined;
}

export interface Conflicts {
  /** Files of the folder the Template writes over, such as its devcontainer.json or a .devcontainer/Dockerfile */
  overwritten: string[];
  /**
   * A root .devcontainer.json the Template does not write: kept, it would leave the folder with two configurations,
   * so replacing moves it out of the way
   */
  obsoleteConfig?: string;
}

/** What applying `template` would replace in the folder */
export function findConflicts(
  workspaceFolder: string,
  template: Pick<TemplateEntry, 'files' | 'optionalPaths'>,
  exists: (file: string) => boolean,
  includeOptionalPaths = false,
): Conflicts {
  const files = templateFiles(template, includeOptionalPaths);
  const overwritten = files
    .map(file => path.join(workspaceFolder, ...file.split('/')))
    .filter(exists);
  const root = path.join(workspaceFolder, '.devcontainer.json');
  const writesConfig = files.some(
    file => path.posix.basename(file) === 'devcontainer.json',
  );
  return {
    overwritten,
    obsoleteConfig:
      writesConfig && !files.includes('.devcontainer.json') && exists(root)
        ? root
        : undefined,
  };
}
