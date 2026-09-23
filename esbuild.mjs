// Bundles the extension host code and the webview scripts.
// Usage: node esbuild.mjs [--watch] [--production]
import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    // Webview scripts; Chart.js is bundled in, so no CDN is ever needed.
    ...shared,
    entryPoints: { stats: 'src/webview/stats.ts' },
    outdir: 'media/dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (production) {
  // Drop dev source maps so they are never packaged.
  for (const dir of ['dist', 'media/dist']) rmSync(dir, { recursive: true, force: true });
}

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
