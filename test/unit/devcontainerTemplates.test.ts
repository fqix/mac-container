import * as assert from 'assert';
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {parse} from 'jsonc-parser';

import {
  addFeatures,
  addPostCreateCommand,
  AGENT_PATH_MARKER,
  agentInstallCommand,
  asDirectTemplate,
  applyTemplate,
  findConflicts,
  featureIncompatibility,
  featureReference,
  parseTemplateIndex,
  substituteOptions,
  supportsCodingAgents,
  templateArgs,
  templateFiles,
  templateIncompatibility,
  UNSUPPORTED_FEATURES,
} from '../../src/services/devcontainerTemplates';

// The Templates bundled with the extension; compiled to out/test/unit
const bundled = path.resolve(
  __dirname,
  '../../../resources/devcontainer-templates',
);
const index = parseTemplateIndex(
  JSON.parse(fs.readFileSync(path.join(bundled, 'index.json'), 'utf8')),
);
const templateDir = (id: string) => path.join(bundled, id.split('/').pop()!);
const template = (name: string) =>
  index.templates.find(t => t.id.endsWith(`/${name}`))!;
const feature = (name: string) =>
  index.features.find(f => f.id.endsWith(`/${name}`))!;

describe('dev container templates', () => {
  it('bundles only Templates and Features Apple container can run', () => {
    assert.ok(index.templates.length >= 15, 'too few Templates bundled');
    for (const t of index.templates) {
      assert.strictEqual(templateIncompatibility(t), undefined, t.id);
      assert.ok(
        t.files.some(f => f.endsWith('devcontainer.json')),
        t.id,
      );
      for (const file of t.files) {
        const text = fs.readFileSync(
          path.join(templateDir(t.id), ...file.split('/')),
          'utf8',
        );
        for (const word of [...UNSUPPORTED_FEATURES, 'docker.sock']) {
          assert.ok(!text.includes(word), `${t.id} ${file} uses ${word}`);
        }
      }
    }
    for (const f of index.features) {
      assert.strictEqual(featureIncompatibility(f), undefined, f.id);
    }
    assert.ok(feature('node'));
    assert.strictEqual(
      templateIncompatibility({id: 'x', type: 'dockerCompose'}),
      'compose',
    );
    assert.strictEqual(
      featureIncompatibility({
        id: 'ghcr.io/devcontainers/features/nvidia-cuda',
      }),
      'gpu',
    );
  });

  it('reads Template options', () => {
    const variant = template('python').options.imageVariant;
    assert.strictEqual(variant.type, 'string');
    assert.ok(variant.proposals?.includes(variant.default!));
    assert.deepStrictEqual(parseTemplateIndex({}), {
      templates: [],
      features: [],
    });
  });

  it('fills in option defaults and replaces placeholders like the CLI', () => {
    const python = template('python');
    assert.deepStrictEqual(templateArgs(python), {
      imageVariant: python.options.imageVariant.default,
    });
    assert.deepStrictEqual(templateArgs(python, {imageVariant: '3.12'}), {
      imageVariant: '3.12',
    });
    assert.strictEqual(
      substituteOptions(
        'python:${templateOption:imageVariant} ${templateOption: missing }!',
        {imageVariant: '3.12-bookworm'},
      ),
      'python:3.12-bookworm !',
    );
  });

  it('adds Features to devcontainer.json and keeps its comments', () => {
    const text =
      '// Comment\n{\n\t"image": "x",\n\t// "features": {},\n\t"name": "n"\n}\n';
    const added = addFeatures(text, [feature('node'), feature('github-cli')]);
    assert.match(added, /^\/\/ Comment/);
    assert.match(added, /\/\/ "features": \{\},/);
    assert.deepStrictEqual(Object.keys(parse(added).features), [
      featureReference(feature('node')),
      featureReference(feature('github-cli')),
    ]);
    const existing = addFeatures('{"features": {"a:1": {"x": 1}}}', [
      feature('node'),
    ]);
    assert.deepStrictEqual(parse(existing).features, {
      'a:1': {x: 1},
      [featureReference(feature('node'))]: {},
    });
    assert.strictEqual(addFeatures(text, []), text);
    assert.match(
      featureReference(feature('node')),
      /^ghcr\.io\/devcontainers\/features\/node:\d+$/,
    );
  });

  it('leaves optional files out unless asked', () => {
    const python = template('python');
    assert.ok(python.files.includes('.github/dependabot.yml'));
    assert.ok(!templateFiles(python).includes('.github/dependabot.yml'));
    assert.ok(templateFiles(python, true).includes('.github/dependabot.yml'));
    assert.strictEqual(
      templateFiles({optionalPaths: ['tests/*'], files: ['a', 'tests/b']})
        .length,
      1,
    );
  });

  it('writes a Template into a folder', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
    try {
      const python = template('python');
      const written = await applyTemplate({
        templateDir: templateDir(python.id),
        workspaceFolder: folder,
        template: python,
        args: {imageVariant: '3.12-bookworm'},
        features: [feature('node')],
      });
      const config = path.join(folder, '.devcontainer', 'devcontainer.json');
      assert.deepStrictEqual(written, [config]);
      const text = fs.readFileSync(config, 'utf8');
      assert.ok(!text.includes('${templateOption'));
      const parsed = parse(text);
      assert.match(parsed.image, /:3-3\.12-bookworm$/);
      assert.ok(featureReference(feature('node')) in parsed.features);
      // No empty .github left behind
      assert.ok(!fs.existsSync(path.join(folder, '.github')));
    } finally {
      fs.rmSync(folder, {recursive: true, force: true});
    }
  });

  it('installs coding agents with their official scripts and puts them on PATH', () => {
    const all = agentInstallCommand(['claude', 'codex', 'opencode']);
    // Downloaded first, so a failed download is a failed install, then run with the shell the docs pipe it to
    assert.ok(
      all.includes(
        `script=$(curl -fsSL https://claude.ai/install.sh) && printf '%s\\n' "$script" | bash || failed="$failed, Claude Code"`,
      ),
    );
    assert.ok(
      all.includes(
        `script=$(curl -fsSL https://chatgpt.com/codex/install.sh) && printf '%s\\n' "$script" | sh || failed="$failed, Codex"`,
      ),
    );
    // One single-quoted PATH line per directory, so $HOME and $PATH expand when a shell starts
    assert.ok(
      all.includes(
        `'export PATH="$HOME/.opencode/bin:$PATH" ${AGENT_PATH_MARKER}'`,
      ),
    );
    const claude = agentInstallCommand(['claude']);
    assert.ok(!claude.includes('codex') && !claude.includes('.opencode'));
    assert.ok(!supportsCodingAgents(template('alpine')));
    assert.ok(supportsCodingAgents(template('python')));
  });

  it("reports failed agent installs, succeeds anyway and adds a new agent's PATH line later", () => {
    // Runs the command for real with a curl that serves a script for claude.ai and fails for opencode.ai
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bin-'));
    try {
      fs.writeFileSync(
        path.join(bin, 'curl'),
        '#!/bin/sh\ncase "$*" in *claude.ai*) echo "echo installed claude";; *) exit 22;; esac\n',
        {mode: 0o755},
      );
      fs.writeFileSync(path.join(home, '.bashrc'), '# user rc\n');
      const run = (agents: ('claude' | 'opencode')[]) =>
        execFileSync(
          '/bin/sh',
          ['-c', `{ ${agentInstallCommand(agents)}; } 2>&1`],
          {
            env: {HOME: home, PATH: `${bin}:/usr/bin:/bin`},
            encoding: 'utf8',
          },
        );
      assert.match(run(['claude']), /installed claude/);
      const out = run(['claude', 'opencode']);
      assert.match(out, /Could not install: opencode/);
      assert.doesNotMatch(out, /Could not install:.*Claude/);
      const bashrc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
      assert.match(bashrc, /^# user rc$/m);
      const count = (dir: string) =>
        bashrc.split('\n').filter(l => l.includes(`$HOME/${dir}:$PATH`)).length;
      // Added once, and the second run still adds the line of the newly chosen agent
      assert.strictEqual(count('.local/bin'), 1);
      assert.strictEqual(count('.opencode/bin'), 1);
      assert.match(
        bashrc,
        /^export PATH="\$HOME\/\.local\/bin:\$PATH" # Added by/m,
      );
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
      fs.rmSync(bin, {recursive: true, force: true});
    }
  });

  it("adds a postCreateCommand and keeps the Template's own", () => {
    const commented = '{\n\t// "postCreateCommand": "x",\n\t"image": "i"\n}';
    const added = addPostCreateCommand(commented, 'coding-agents', 'install');
    assert.match(added, /\/\/ "postCreateCommand": "x"/);
    assert.strictEqual(parse(added).postCreateCommand, 'install');
    assert.deepStrictEqual(
      parse(
        addPostCreateCommand('{"postCreateCommand": "own"}', 'k', 'install'),
      ).postCreateCommand,
      {template: 'own', k: 'install'},
    );
    assert.deepStrictEqual(
      parse(
        addPostCreateCommand(
          '{"postCreateCommand": {"a": "x"}}',
          'k',
          'install',
        ),
      ).postCreateCommand,
      {a: 'x', k: 'install'},
    );
  });

  it('writes the agent install into a Template that has its own postCreateCommand', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
    try {
      const powershell = template('powershell');
      const [config] = await applyTemplate({
        templateDir: templateDir(powershell.id),
        workspaceFolder: folder,
        template: powershell,
        agents: ['claude'],
      });
      const {postCreateCommand} = parse(fs.readFileSync(config, 'utf8'));
      assert.match(postCreateCommand.template, /chsh/);
      assert.strictEqual(
        postCreateCommand['coding-agents'],
        agentInstallCommand(['claude']),
      );
    } finally {
      fs.rmSync(folder, {recursive: true, force: true});
    }
  });

  it('takes only a real DirectTemplate as the second command argument', () => {
    // What the explorer passes: the selected URIs
    assert.strictEqual(asDirectTemplate([{fsPath: '/a'}]), undefined);
    assert.strictEqual(asDirectTemplate(undefined), undefined);
    assert.deepStrictEqual(asDirectTemplate({template: 'x'}), {template: 'x'});
  });

  it('finds every file a Template would write over, and a root configuration it would leave behind', () => {
    const python = template('python');
    const present = new Set([
      '/app/.devcontainer/devcontainer.json',
      '/app/.devcontainer.json',
      // Optional, and not written
      '/app/.github/dependabot.yml',
    ]);
    assert.deepStrictEqual(
      findConflicts('/app', python, f => present.has(f)),
      {
        overwritten: ['/app/.devcontainer/devcontainer.json'],
        obsoleteConfig: '/app/.devcontainer.json',
      },
    );
    // A Dockerfile-type Template also writes .devcontainer/Dockerfile
    const withDockerfile = index.templates.find(t =>
      t.files.includes('.devcontainer/Dockerfile'),
    )!;
    assert.deepStrictEqual(
      findConflicts(
        '/app',
        withDockerfile,
        f => f === '/app/.devcontainer/Dockerfile',
      ),
      {
        overwritten: ['/app/.devcontainer/Dockerfile'],
        obsoleteConfig: undefined,
      },
    );
    assert.deepStrictEqual(
      findConflicts('/app', python, () => false),
      {
        overwritten: [],
        obsoleteConfig: undefined,
      },
    );
  });

  it("writes the user's files writable, whatever the bundled files are", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'template-src-'));
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
    try {
      fs.mkdirSync(path.join(source, '.devcontainer'));
      fs.writeFileSync(
        path.join(source, '.devcontainer', 'devcontainer.json'),
        '{}',
        {mode: 0o444},
      );
      fs.writeFileSync(path.join(source, '.devcontainer', 'setup.sh'), 'true', {
        mode: 0o555,
      });
      await applyTemplate({
        templateDir: source,
        workspaceFolder: folder,
        template: {
          files: ['.devcontainer/devcontainer.json', '.devcontainer/setup.sh'],
          optionalPaths: [],
          options: {},
        },
      });
      const mode = (file: string) =>
        fs.statSync(path.join(folder, '.devcontainer', file)).mode & 0o777;
      assert.strictEqual(mode('devcontainer.json'), 0o644);
      assert.strictEqual(mode('setup.sh'), 0o755);
    } finally {
      fs.rmSync(source, {recursive: true, force: true});
      fs.rmSync(folder, {recursive: true, force: true});
    }
  });
});
