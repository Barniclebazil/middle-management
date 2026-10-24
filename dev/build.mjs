import { build } from 'esbuild';

const common = { bundle: true, platform: 'browser', format: 'iife', target: 'es2020', sourcemap: false, logLevel: 'info' };

await build({ ...common, entryPoints: ['dev/harness.ts'], outfile: 'dev/out/harness.js' });
// The panel playground (dev/panels.html): the icon bar and drawer with a mock context.
await build({ ...common, entryPoints: ['dev/panels.ts'], outfile: 'dev/out/panels.js' });
// The case tab playground (dev/caseTab.html): a mock host for dist/case.js.
await build({ ...common, entryPoints: ['dev/caseTabHarness.ts'], outfile: 'dev/out/caseTabHarness.js' });
