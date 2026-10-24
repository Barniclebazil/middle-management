// Bundles dev/sdk-bundle-check.ts the way the extension bundle is built (platform node, format cjs, target node18) to
// prove @anthropic-ai/claude-agent-sdk (ESM, uses import.meta.url) can be inlined. Not part of the real build.
//
//   node dev/sdk-bundle-check.mjs [--external] [--production]
//   node <outfile>
//
// Output goes to SPIKE_ROOT/bundle-check (scratch), never into dist/. With --external the SDK is left as a runtime
// require() instead (that variant needs the SDK's own files next to the bundle, so it is only a comparison).
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root =
  process.env.SPIKE_ROOT ??
  'path.join(os.tmpdir(), 'middle-management-spike')';
const external = process.argv.includes('--external');
const production = process.argv.includes('--production');
const outfile = path.join(root, 'bundle-check', external ? 'check-external.cjs' : 'check.cjs');

const result = await build({
  entryPoints: [path.join(here, 'sdk-bundle-check.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  minify: production,
  sourcemap: false,
  logLevel: 'warning',
  metafile: true,
  external: external ? ['@anthropic-ai/claude-agent-sdk'] : [],
  // The SDK is ESM and calls createRequire(import.meta.url). In a CJS bundle import.meta is empty, so point it at the
  // bundle file itself. (Anything the SDK resolved relative to its own files would break; see docs/sdk-spike.md.)
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
});

console.log(`wrote ${outfile} (${(statSync(outfile).size / 1024).toFixed(0)} KiB), warnings: ${result.warnings.length}`);
const inputs = Object.entries(result.metafile.inputs)
  .map(([f, v]) => [f, v.bytes])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5);
for (const [f, bytes] of inputs) console.log(`  ${(bytes / 1024).toFixed(0).padStart(6)} KiB  ${f}`);
