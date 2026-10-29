import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };

// Webviews are a separate Vite + React project in webview-ui/

const contexts = await Promise.all([
  // Extension host (Node)
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    // Prefer ESM entries: the UMD build of jsonc-parser loads its modules with a dynamic require esbuild cannot follow
    mainFields: ['module', 'main'],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
