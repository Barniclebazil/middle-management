import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// lineCheck.ts pulls in overlay.ts and the art, which use DOM types the root tsconfig lacks: computed specifier (see engine-world.ts).
const CHECK_SPEC: string = new URL('../dev/lineCheck.ts', import.meta.url).href;
const { checkPreset, BANNED_TERMS, SHOW_TERMS, BRAND_TERMS, STYLE_TERMS } = await import(CHECK_SPEC) as {
  checkPreset: (t: unknown) => { lines: number; findings: { severity: string; path: string; text: string; message: string }[] };
  BANNED_TERMS: readonly string[];
  SHOW_TERMS: readonly string[];
  BRAND_TERMS: readonly string[];
  STYLE_TERMS: readonly string[];
};

const DIR = new URL('../media/themes/', import.meta.url);
const files = readdirSync(DIR).filter((n) => n.endsWith('.json')).sort();

/** Only errors: warnings (wrapping, gendered words, odd capitals) are advice, not failures. */
const errorsOf = (t: unknown): string[] => checkPreset(t).findings
  .filter((f) => f.severity === 'error')
  .map((f) => `${f.path} "${f.text}": ${f.message}`);

// A fixture is written inline on purpose: the real presets are not the place to test the checker.
const CLEAN_FIXTURE = {
  name: 'Fixture Office',
  description: 'A small office for the checker to read.',
  titles: { manager: 'Office Lead', cleaner: 'Caretaker' },
  cleaner: { name: 'Sam' },
  itFixer: { name: 'Pat' },
  lines: {
    bossVisit: ['Just checking in.', 'How is the spreadsheet going?'],
    itFixerTalk: [['Fine, thanks.', 'Good to hear.']],
  },
};

test('a banned term or non-ASCII in company, branch, manager, receptionist, staff and temp names and roles is reported', () => {
  const term = SHOW_TERMS[0]!;
  const bad = {
    ...CLEAN_FIXTURE,
    company: `${term} Co`,
    branch: 'Caf\u00e9 Branch',
    manager: { name: `Ann ${term}` },
    receptionist: { name: `Bo ${term}` },
    staff: [{ name: 'Fine Name', role: 'Clerk' }, { name: `Cy ${term}`, role: `${term} Lead` }],
    temps: [{ name: `Di ${term}` }],
  };
  const paths = errorsOf(bad).map((e) => e.split(' ')[0]);
  for (const p of ['company', 'branch', 'manager.name', 'receptionist.name', 'staff[1].name', 'staff[1].role', 'temps[0].name']) assert.ok(paths.includes(p), `${p} reported: ${paths.join(', ')}`);
  assert.ok(!paths.includes('staff[0].name') && !paths.includes('staff[0].role'));
});

test('a clean inline fixture has no errors', () => {
  assert.deepEqual(errorsOf(CLEAN_FIXTURE), []);
});

test('an inline fixture reports a too-long line, a non-ASCII pair half and a banned title, each by path', () => {
  const bad = structuredClone(CLEAN_FIXTURE) as typeof CLEAN_FIXTURE & { lines: Record<string, unknown> };
  bad.lines.bossVisit = ['Quarterly figures, quarterly figures, quarterly figures, quarterly figures, quarterly figures.'];
  bad.lines.itFixerTalk = [['Fine, thanks.', 'Café opens at nine.']];
  (bad.titles as Record<string, string>).manager = 'Claude Lead';
  const errors = errorsOf(bad);
  assert.deepEqual(errors.map((e) => e.split(' ')[0]).sort(), ['lines.bossVisit[0]', 'lines.itFixerTalk[0][1]', 'titles.manager']);
  assert.match(errors.find((e) => e.startsWith('lines.bossVisit[0]'))!, /needs \d+ rows/);
  assert.match(errors.find((e) => e.startsWith('lines.itFixerTalk[0][1]'))!, /U\+00E9/);
  assert.match(errors.find((e) => e.startsWith('titles.manager'))!, /banned term "claude"/);
});

test('a banned name in a side character name is reported by path', () => {
  const bad = structuredClone(CLEAN_FIXTURE);
  bad.cleaner = { name: 'Claude' };
  assert.deepEqual(errorsOf(bad).map((e) => e.split(' ')[0]), ['cleaner.name']);
});

test('SHOW_TERMS is a non-empty subset of the banned list, and the banned list is the union of the three', () => {
  assert.ok(SHOW_TERMS.length > 0, 'SHOW_TERMS is empty');
  for (const term of SHOW_TERMS) assert.ok(BANNED_TERMS.includes(term), `${term} is not banned`);
  assert.deepEqual([...BANNED_TERMS].sort(), [...SHOW_TERMS, ...BRAND_TERMS, ...STYLE_TERMS].sort());
});

test('there are theme presets to check', () => {
  assert.ok(files.length >= 6, `found ${files.length}`);
});

for (const file of files) {
  test(`${file}: every speech line, title and name passes the checks with no errors`, () => {
    const t = JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));
    const { lines } = checkPreset(t);
    assert.ok(lines > 0, 'the preset has lines');
    assert.deepEqual(errorsOf(t), []);
  });
}
