// Refreshes resources/devcontainer-templates: the official Dev Container Templates that Apple container can run,
// downloaded from ghcr.io as published (the OCI layer of each Template, checked against its digest), plus the official
// Features the Add Features step offers. The extension applies these files itself, so it works offline.
//
//   npm run update:templates
//
// Templates that use Docker Compose or need a Docker daemon are left out (see templateIncompatibility in
// src/services/devcontainerTemplates.ts; test/unit/devcontainerTemplates.test.ts checks the result against it).
import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
);
const target = path.join(root, 'resources', 'devcontainer-templates');
const INDEX_URL = 'https://containers.dev/static/devcontainer-index.json';
const TEMPLATES = 'ghcr.io/devcontainers/templates/';
const FEATURES = 'ghcr.io/devcontainers/features/';
const SKIPPED_TEMPLATES = new Set([
  'docker-in-docker',
  'docker-outside-of-docker',
  'kubernetes-helm-minikube',
]);
const SKIPPED_FEATURES = new Set([
  'docker-in-docker',
  'docker-outside-of-docker',
  'nvidia-cuda',
]);
/** Documentation files of the artifact; the CLI does not apply them either */
const NOT_APPLIED = new Set([
  'devcontainer-template.json',
  'README.md',
  'NOTES.md',
]);

async function json(url, headers = {}) {
  const response = await fetch(url, {headers});
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

/** The Template's single layer: a tar of its files */
async function downloadLayer(name, version) {
  const repo = `devcontainers/templates/${name}`;
  const {token} = await json(
    `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
  );
  const auth = {Authorization: `Bearer ${token}`};
  const manifest = await json(
    `https://ghcr.io/v2/${repo}/manifests/${version}`,
    {...auth, Accept: 'application/vnd.oci.image.manifest.v1+json'},
  );
  const [layer] = manifest.layers ?? [];
  if (!layer?.digest) {
    throw new Error(`${repo}:${version}: no layer in the manifest`);
  }
  const response = await fetch(
    `https://ghcr.io/v2/${repo}/blobs/${layer.digest}`,
    {headers: auth},
  );
  if (!response.ok) {
    throw new Error(`${repo}:${version}: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  if (digest !== layer.digest) {
    throw new Error(`${repo}:${version}: digest ${digest} != ${layer.digest}`);
  }
  return data;
}

function listFiles(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) {
      listFiles(file, base, out);
    } else {
      out.push(path.relative(base, file).split(path.sep).join('/'));
    }
  }
  return out;
}

const index = await json(INDEX_URL);
const all = index.collections.flatMap(c => c.templates ?? []);
const templates = all.filter(
  t =>
    t.id.startsWith(TEMPLATES) &&
    t.type !== 'dockerCompose' &&
    !SKIPPED_TEMPLATES.has(t.id.slice(TEMPLATES.length)),
);
const features = index.collections
  .flatMap(c => c.features ?? [])
  .filter(
    f =>
      f.id.startsWith(FEATURES) &&
      !SKIPPED_FEATURES.has(f.id.slice(FEATURES.length)),
  )
  .map(({id, version, name, description}) => ({id, version, name, description}))
  .sort((a, b) => a.name.localeCompare(b.name));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devcontainer-templates-'));
const entries = [];
try {
  for (const t of templates) {
    const name = t.id.slice(TEMPLATES.length);
    process.stdout.write(`${name}@${t.version} ... `);
    const tar = path.join(work, `${name}.tar`);
    fs.writeFileSync(tar, await downloadLayer(name, t.version));
    // Each archive into its own empty directory
    const dir = path.join(work, name);
    fs.mkdirSync(dir);
    execFileSync('tar', ['-xf', tar, '-C', dir]);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(dir, 'devcontainer-template.json'), 'utf8'),
    );
    for (const file of listFiles(dir)) {
      if (NOT_APPLIED.has(file)) {
        fs.rmSync(path.join(dir, file));
      }
    }
    // A Template whose files use a skipped Feature or the host's Docker socket cannot run either
    const text = listFiles(dir)
      .map(file => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
    const blocker = [...SKIPPED_FEATURES, 'docker.sock'].find(word =>
      text.includes(word),
    );
    if (blocker) {
      console.log(`skipped: uses ${blocker}`);
      continue;
    }
    entries.push({
      id: t.id,
      version: metadata.version ?? t.version,
      name: metadata.name ?? t.name,
      description: metadata.description ?? t.description,
      documentationURL: metadata.documentationURL ?? t.documentationURL,
      type: t.type,
      options: metadata.options ?? {},
      optionalPaths: metadata.optionalPaths ?? [],
      files: listFiles(dir),
    });
    console.log('ok');
  }
  fs.rmSync(target, {recursive: true, force: true});
  fs.mkdirSync(target, {recursive: true});
  for (const entry of entries) {
    const name = entry.id.slice(TEMPLATES.length);
    fs.cpSync(path.join(work, name), path.join(target, name), {
      recursive: true,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(
    path.join(target, 'index.json'),
    JSON.stringify({source: INDEX_URL, templates: entries, features}, null, 2) +
      '\n',
  );
  console.log(
    `${entries.length} Templates and ${features.length} Features in ${path.relative(root, target)}`,
  );
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}
