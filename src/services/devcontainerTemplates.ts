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

export type CodingAgent = 'claude' | 'codex' | 'opencode';

/** The official install scripts and where they put the agent, relative to the home directory */
export const CODING_AGENTS: readonly {
  id: CodingAgent;
  name: string;
  install: string;
  binDir: string;
}[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    binDir: '.local/bin',
  },
  {
    id: 'codex',
    name: 'Codex',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    binDir: '.local/bin',
  },
  {
    id: 'opencode',
    name: 'opencode',
    install: 'curl -fsSL https://opencode.ai/v2/install | bash',
    binDir: '.opencode/bin',
  },
];

/** Marks the PATH line agentInstallCommand adds, so running it again adds none */
export const AGENT_PATH_MARKER =
  'Added by Apple Container Tools: coding agents';

/**
 * A postCreateCommand that installs the agents with their official scripts, one after another (one failing does not
 * stop the others), then puts their directories on PATH for every shell: the scripts only set it up for some (opencode
 * only in .bashrc, none in zsh). POSIX only: the string runs with /bin/sh, which is dash on Debian and Ubuntu. The
 * image needs curl and bash, as the official devcontainers images have.
 */
export function agentInstallCommand(agents: readonly CodingAgent[]): string {
  const chosen = CODING_AGENTS.filter(a => agents.includes(a.id));
  // `\$` so that $HOME and $PATH are written into the file and expand when a shell starts
  const dirs = [...new Set(chosen.map(a => `\\$HOME/${a.binDir}`))].join(':');
  // Escaped for the double-quoted printf argument below
  const pathLine = `export PATH=\\"${dirs}:\\$PATH\\"`;
  const pathFix =
    'for rc in .bashrc .profile .zshenv; do ' +
    '[ "$rc" = .zshenv ] && ! command -v zsh >/dev/null && continue; ' +
    `grep -qs "${AGENT_PATH_MARKER}" "$HOME/$rc" || ` +
    `printf "\\n# ${AGENT_PATH_MARKER}\\n${pathLine}\\n" >> "$HOME/$rc"; done`;
  return [...chosen.map(a => a.install), pathFix].join('; ');
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
    // Scripts such as ensure-mount-sources stay executable
    await chmod(target, (await stat(source)).mode & 0o777);
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

/** Configurations a Template would overwrite */
export const CONFIG_PATHS = [
  path.join('.devcontainer', 'devcontainer.json'),
  '.devcontainer.json',
];

export function existingConfigs(
  workspaceFolder: string,
  exists: (file: string) => boolean,
): string[] {
  return CONFIG_PATHS.map(p => path.join(workspaceFolder, p)).filter(exists);
}
