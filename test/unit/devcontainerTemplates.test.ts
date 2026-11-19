import * as assert from 'assert';
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
  existingConfigs,
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
    // The command checked under dash in mcr.microsoft.com/devcontainers/base:ubuntu: every agent found by bash and
    // zsh, login and interactive, and a second run adds no second PATH line
    assert.strictEqual(
      agentInstallCommand(['claude', 'codex', 'opencode']),
      'curl -fsSL https://claude.ai/install.sh | bash; ' +
        'curl -fsSL https://chatgpt.com/codex/install.sh | sh; ' +
        'curl -fsSL https://opencode.ai/v2/install | bash; ' +
        'for rc in .bashrc .profile .zshenv; do [ "$rc" = .zshenv ] && ! command -v zsh >/dev/null && continue; ' +
        `grep -qs "${AGENT_PATH_MARKER}" "$HOME/$rc" || ` +
        `printf "\\n# ${AGENT_PATH_MARKER}\\nexport PATH=\\"\\$HOME/.local/bin:\\$HOME/.opencode/bin:\\$PATH\\"\\n" >> "$HOME/$rc"; done`,
    );
    const claude = agentInstallCommand(['claude']);
    assert.ok(!claude.includes('codex') && !claude.includes('.opencode'));
    assert.ok(!supportsCodingAgents(template('alpine')));
    assert.ok(supportsCodingAgents(template('python')));
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

  it('finds configurations that would be overwritten', () => {
    const present = new Set(['/app/.devcontainer.json']);
    assert.deepStrictEqual(
      existingConfigs('/app', f => present.has(f)),
      ['/app/.devcontainer.json'],
    );
  });
});
