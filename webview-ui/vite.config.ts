import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds a single script + stylesheet into the extension's dist/webview.
// File names are fixed because the extension host references them directly (src/panels/webviewHtml.ts).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    target: 'chrome120',
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    rolldownOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'webview.js',
        chunkFileNames: 'webview-[name].js',
        assetFileNames: 'webview[extname]',
      },
    },
  },
}));
