import { context, build } from 'esbuild';
import { readFileSync } from 'node:fs';

/** Versions of the bundled Agent SDK, baked into the extension bundle for the log-only version check. */
const sdkPkg = JSON.parse(readFileSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'));

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    // The bundled Agent SDK reads `import.meta.url` once at load; in a cjs bundle that must be defined away
    // (docs/sdk-spike.md section 8). Extension bundle only.
    define: {
      'import.meta.url': 'importMetaUrl',
      __SDK_VERSION__: JSON.stringify(String(sdkPkg.version ?? '')),
      __SDK_CLAUDE_CODE_VERSION__: JSON.stringify(String(sdkPkg.claudeCodeVersion ?? '')),
    },
    banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  },
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
  // A case tab (v0.5): one worker's case file in its own editor tab (docs/manager-mode.md section 18).
  {
    entryPoints: ['webview/caseMain.ts'],
    outfile: 'dist/case.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
  // Dev-only sprite gallery (dev/sprites.html). Lives outside dist/ so it never ships.
  {
    entryPoints: ['dev/gallery.ts'],
    outfile: 'dev/out/gallery.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
].map((c) => ({
  ...c,
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}));

if (watch) {
  for (const c of configs) {
    const ctx = await context(c);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => build(c)));
}
