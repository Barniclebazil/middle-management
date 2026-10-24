import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINE_POOL_KEYS, OFFICE_COLOR_KEYS, TITLE_KEYS, parseTheme } from '../src/shared/theme.ts';

// The generator and lineCheck.ts pull in webview modules with DOM types the root tsconfig lacks: computed specifiers
// (see shared-presetLines.test.ts).
const GUIDE_SPEC: string = new URL('../dev/theme-guide.ts', import.meta.url).href;
const CHECK_SPEC: string = new URL('../dev/lineCheck.ts', import.meta.url).href;
const { buildGuide } = await import(GUIDE_SPEC) as { buildGuide: () => string };
const { bannedIn, checkFit } = await import(CHECK_SPEC) as {
  bannedIn: (text: string) => string[];
  checkFit: (text: string, pool: string, index: number) => { message: string }[];
};

const guide = readFileSync(new URL('../media/theme-guide.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../media/skill/SKILL.md', import.meta.url), 'utf8');

/** The JSON block under the guide's "Example" heading. */
function exampleJson(): string {
  const m = /^## \d+\. Example\n[\s\S]*?^```json\n([\s\S]*?)^```$/m.exec(guide);
  assert.ok(m, 'the guide has an Example section with a json block');
  return m[1]!;
}

/** Characters outside printable ASCII (newlines allowed), with their line numbers. */
function nonAscii(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const ch of line) if (ch < ' ' || ch > '~') out.push(`line ${i + 1}: U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  });
  return out;
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'SKILL.md starts with a --- frontmatter block');
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z-]+): (.+)$/.exec(line);
    assert.ok(kv, `frontmatter line is "key: value": ${line}`);
    out[kv[1]!] = kv[2]!;
  }
  return out;
}

test('media/theme-guide.md is current (run dev/theme-guide.ts to regenerate)', () => {
  assert.equal(guide, buildGuide());
});

test("the guide's example theme parses with no errors", () => {
  const { theme, errors } = parseTheme(JSON.parse(exampleJson()));
  assert.deepEqual(errors, []);
  assert.equal(theme.lineMode, 'replace');
});

test("every line in the guide's example fits a speech bubble", () => {
  const t = JSON.parse(exampleJson()) as { lines: Record<string, (string | string[])[]>; smallTalk: string[][]; staff: { lines?: string[] }[] };
  const texts = [
    ...Object.values(t.lines).flat(2),
    ...t.smallTalk.flat(),
    ...t.staff.flatMap((s) => s.lines ?? []),
  ];
  assert.ok(texts.length > 10);
  assert.deepEqual(texts.flatMap((s, i) => checkFit(s, 'example', i).map((f) => `"${s}": ${f.message}`)), []);
  assert.deepEqual(texts.filter((s) => s.length > 70), []);
});

test('the guide names every pool, title and colour key', () => {
  for (const k of [...LINE_POOL_KEYS, ...TITLE_KEYS, ...OFFICE_COLOR_KEYS]) assert.ok(guide.includes(`\`${k}\``), k);
});

test('the guide and SKILL.md are printable ASCII', () => {
  assert.deepEqual(nonAscii(guide), []);
  assert.deepEqual(nonAscii(skill), []);
});

test('SKILL.md has a valid frontmatter and the installer placeholders', () => {
  const fm = frontmatter(skill);
  assert.equal(fm.name, 'middle-management-theme');
  assert.ok(fm.description, 'has a description');
  assert.ok(fm.description.includes('make me a theme for Middle Management'), 'description has the trigger phrase');
  assert.ok(fm.description.length <= 500, `description is ${fm.description.length} characters`);
  assert.ok(skill.includes('{{THEMES_DIR}}'));
  assert.ok(skill.includes('{{VERSION}}'));
});

test('neither file uses a banned term', () => {
  for (const [file, text] of [['theme-guide.md', guide], ['SKILL.md', skill]] as const) {
    const hits = text.split('\n').flatMap((line, i) => bannedIn(line).map((t) => `${file}:${i + 1} "${t}"`));
    assert.deepEqual(hits, []);
  }
});
