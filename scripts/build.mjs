// Bundles the renderer and preload with esbuild and copies static assets to dist/.
//
// Why bundle: the SmartSpectra renderer SDK (`@smartspectra/node-sdk/renderer`)
// and its message decoder (`/messages`) are CommonJS and must be bundled for the
// sandboxed renderer. Never import the package root from the renderer: it loads
// the native FFI layer (koffi), which can't run in a browser context.

import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/renderer/app.mjs')],
  outfile: path.join(dist, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(root, 'src/preload.js')],
  outfile: path.join(dist, 'preload.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info',
});

for (const file of ['index.html', 'styles.css']) {
  await copyFile(path.join(root, 'src/renderer', file), path.join(dist, file));
}

console.log('Built dist/');
