// Verifies that every vscode.l10n.t() string and every package.json %key% has a translation in each locale bundle
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const errors = [];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      walk(p, out);
    } else if (p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

const runtimeKeys = new Set();
for (const file of walk(path.join(root, 'src'))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/l10n\.t\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gs)) {
    runtimeKeys.add(m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
  }
}

const pkgText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const nlsKeys = new Set([...pkgText.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
const nlsDefault = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
for (const key of nlsKeys) {
  if (!(key in nlsDefault)) {
    errors.push(`package.nls.json: missing "${key}"`);
  }
}

for (const file of fs.readdirSync(root).filter((f) => /^package\.nls\..+\.json$/.test(f))) {
  const bundle = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const key of nlsKeys) {
    if (!(key in bundle)) {
      errors.push(`${file}: missing "${key}"`);
    }
  }
}

const l10nDir = path.join(root, 'l10n');
for (const file of fs.readdirSync(l10nDir).filter((f) => f.endsWith('.json'))) {
  const bundle = JSON.parse(fs.readFileSync(path.join(l10nDir, file), 'utf8'));
  for (const key of runtimeKeys) {
    if (!(key in bundle)) {
      errors.push(`l10n/${file}: missing ${JSON.stringify(key)}`);
    }
  }
  for (const key of Object.keys(bundle)) {
    if (!runtimeKeys.has(key)) {
      errors.push(`l10n/${file}: unused ${JSON.stringify(key)}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`l10n OK: ${runtimeKeys.size} runtime strings, ${nlsKeys.size} manifest strings`);
