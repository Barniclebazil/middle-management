/**
 * Checks chit-chat lines against the speech bubble and the pixel font.
 *
 *   node --experimental-strip-types --no-warnings dev/check-lines.ts webview/engine/smallTalk/*.ts
 *   node --experimental-strip-types --no-warnings dev/check-lines.ts --presets
 *
 * Errors (exit code 1): does not fit in 3 rows, missing glyph, duplicates, banned terms.
 * Warnings: more than 2 rows, gendered words, capitalised words that may be names or brands.
 * An `index.ts` among the paths is skipped (it only re-combines the other files).
 * `--presets` checks media/themes/*.json: every speech line (fit, glyphs, banned terms, warnings), and the
 * titles, names and description (banned terms and non-ASCII only). Errors there also exit with code 1.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPools, checkPreset, toPool } from './lineCheck.ts';
import type { Pool, PresetLike } from './lineCheck.ts';

function show(f: { severity: string; text: string; message: string }, where: string): string {
  return `  ${f.severity === 'error' ? 'ERROR' : 'warn '} ${where} "${f.text}": ${f.message}`;
}

async function checkModules(paths: string[]): Promise<number> {
  const pools: Pool[] = [];
  const fileOf = new Map<string, string>();
  // A re-exported array is the same object; check it once, under the name of the first module that had it.
  const seen = new Set<unknown>();
  for (const p of paths) {
    const mod = (await import(pathToFileURL(resolve(p)).href)) as Record<string, unknown>;
    let pairs = 0;
    let lines = 0;
    for (const [name, value] of Object.entries(mod)) {
      const pool = toPool(name, value);
      if (!pool || seen.has(value)) continue;
      seen.add(value);
      pools.push(pool);
      fileOf.set(name, basename(p));
      pairs += pool.pairs.length;
      lines += pool.lines.length;
    }
    console.log(`${basename(p)}: ${pairs} pairs, ${lines} lines`);
  }
  const findings = checkPools(pools);
  for (const f of findings) console.log(show(f, `${fileOf.get(f.pool) ?? '?'} ${f.pool}[${f.index}]`));
  const errors = findings.filter((f) => f.severity === 'error').length;
  console.log(`${errors} errors, ${findings.length - errors} warnings`);
  return errors ? 1 : 0;
}

function checkPresets(): number {
  const dir = resolve('media/themes');
  let errors = 0;
  let warnings = 0;
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const t = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as PresetLike;
    const { lines, findings } = checkPreset(t);
    const fileErrors = findings.filter((f) => f.severity === 'error').length;
    errors += fileErrors;
    warnings += findings.length - fileErrors;
    console.log(`${file}: ${lines} speech strings, ${fileErrors} errors, ${findings.length - fileErrors} warnings`);
    for (const f of findings) console.log(show(f, `${file} ${f.path}`));
  }
  console.log(`${errors} errors, ${warnings} warnings`);
  return errors ? 1 : 0;
}

// index.ts only re-combines the topic files, so checking it would flag every line as a duplicate.
const args = process.argv.slice(2).filter((a) => a === '--presets' || basename(a) !== 'index.ts');
if (args.includes('--presets')) process.exit(checkPresets());
if (!args.length) {
  console.error('usage: dev/check-lines.ts <file.ts>... | --presets');
  process.exit(2);
}
process.exit(await checkModules(args));
