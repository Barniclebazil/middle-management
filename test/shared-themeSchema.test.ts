import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LINE_MODES, LINE_POOL_INFO, LINE_POOL_KEYS, LINE_POOL_KIND, NPC_KEYS, OFFICE_COLOR_KEYS, THEME_LIMITS, TITLE_KEYS,
} from '../src/shared/theme.ts';
import type { OfficeTheme } from '../src/shared/theme.ts';

/* media/theme.schema.json drives completions and squiggles for every *.theme.json, and Claude reads it
 * when writing themes. These tests keep it in step with src/shared/theme.ts. */

type Json = any;
const mediaDir = path.join(import.meta.dirname, '..', 'media');
const schema: Json = JSON.parse(fs.readFileSync(path.join(mediaDir, 'theme.schema.json'), 'utf8'));
const keys = (o: object): string[] => Object.keys(o).sort();

/** Every OfficeTheme field, in a record so the compiler flags a field added to the type but missing here. */
const THEME_FIELDS: Record<keyof OfficeTheme, true> = {
  name: true, description: true, company: true, branch: true, lineMode: true, lines: true, titles: true,
  manager: true, receptionist: true, cleaner: true, vendor: true, itFixer: true, itCritic: true,
  colors: true, smallTalk: true, staff: true, temps: true,
};

test('top-level properties are the OfficeTheme fields plus $schema', () => {
  assert.deepEqual(keys(schema.properties), [...Object.keys(THEME_FIELDS), '$schema'].sort());
});

test('colors keys equal OFFICE_COLOR_KEYS, each a #rrggbb string with a description', () => {
  assert.equal(schema.properties.colors.additionalProperties, false);
  assert.deepEqual(keys(schema.properties.colors.properties), [...OFFICE_COLOR_KEYS].sort());
  for (const [k, p] of Object.entries<Json>(schema.properties.colors.properties)) {
    assert.equal(p.type, 'string', k);
    assert.ok(new RegExp(p.pattern).test('#a1B2c3') && !new RegExp(p.pattern).test('#abc'), `${k} pattern`);
    assert.ok(p.description.length > 10, `${k} description`);
  }
});

test('titles keys equal TITLE_KEYS, capped at THEME_LIMITS.title', () => {
  const t = schema.properties.titles;
  assert.equal(t.additionalProperties, false);
  assert.deepEqual(keys(t.properties), [...TITLE_KEYS].sort());
  for (const [k, p] of Object.entries<Json>(t.properties)) {
    assert.equal(p.type, 'string', k);
    assert.equal(p.maxLength, THEME_LIMITS.title, k);
    assert.match(p.description, /Built-in: "/, `${k} names its built-in value`);
  }
});

test('lineMode enum equals LINE_MODES and the description explains replace and smallTalk', () => {
  const m = schema.properties.lineMode;
  assert.deepEqual(m.enum, [...LINE_MODES]);
  assert.match(m.description, /replace/);
  assert.match(m.description, /only/);
  assert.match(m.description, /smallTalk/);
});

test('lines keys equal LINE_POOL_KEYS and each pool has the right shape, caps and description', () => {
  const lines = schema.properties.lines;
  assert.equal(lines.additionalProperties, false);
  assert.deepEqual(keys(lines.properties), [...LINE_POOL_KEYS].sort());
  for (const k of LINE_POOL_KEYS) {
    const p = lines.properties[k];
    assert.equal(p.type, 'array', k);
    assert.equal(p.maxItems, THEME_LIMITS.lines, k);
    let item = p.items;
    if (LINE_POOL_KIND[k] === 'pairs') {
      assert.equal(item.type, 'array', `${k} pair`);
      assert.equal(item.minItems, 2, k);
      assert.equal(item.maxItems, 2, k);
      item = item.items;
    }
    assert.equal(item.type, 'string', k);
    assert.equal(item.minLength, 1, k);
    assert.equal(item.maxLength, THEME_LIMITS.line, k);
    assert.ok(p.description.includes(LINE_POOL_INFO[k].who), `${k} description mentions who says it`);
    assert.ok(p.description.includes(LINE_POOL_INFO[k].when), `${k} description mentions when`);
  }
});

test('people: cleaner, vendor, itFixer and itCritic share a name-and-look definition', () => {
  for (const k of NPC_KEYS) assert.equal(schema.properties[k].$ref, '#/definitions/person', k);
  const p = schema.definitions.person;
  assert.deepEqual(keys(p.properties), ['look', 'name']);
  assert.equal(p.properties.name.maxLength, THEME_LIMITS.name);
  assert.equal(p.properties.look.$ref, '#/definitions/look');
});

test('limits match THEME_LIMITS', () => {
  const pr = schema.properties;
  assert.equal(pr.staff.maxItems, THEME_LIMITS.staff);
  assert.equal(pr.temps.maxItems, THEME_LIMITS.temps);
  assert.equal(pr.smallTalk.maxItems, THEME_LIMITS.smallTalk);
  assert.equal(pr.smallTalk.items.maxItems, 2);
  assert.equal(pr.smallTalk.items.items.maxLength, THEME_LIMITS.line);
  assert.equal(pr.name.maxLength, THEME_LIMITS.name);
  assert.equal(pr.description.maxLength, THEME_LIMITS.description);
  assert.equal(pr.company.maxLength, THEME_LIMITS.name);
  assert.equal(pr.branch.maxLength, THEME_LIMITS.name);
  for (const who of ['manager', 'receptionist'] as const) {
    assert.equal(pr[who].properties.name.maxLength, THEME_LIMITS.name, who);
    assert.equal(pr[who].properties.lines.maxItems, THEME_LIMITS.lines, who);
    assert.equal(pr[who].properties.lines.items.maxLength, THEME_LIMITS.line, who);
  }
  const sm = schema.definitions.staffMember.properties;
  assert.equal(sm.name.maxLength, THEME_LIMITS.name);
  assert.equal(sm.role.maxLength, THEME_LIMITS.role);
  assert.equal(sm.lines.maxItems, THEME_LIMITS.lines);
  assert.equal(sm.lines.items.maxLength, THEME_LIMITS.line);
  assert.equal(sm.pin.properties.project.maxLength, THEME_LIMITS.pin);
  assert.equal(schema.definitions.temp.properties.name.maxLength, THEME_LIMITS.name);
});

test('line descriptions keep the 70-character, plain-ASCII guidance', () => {
  const texts = [
    schema.properties.manager.properties.lines, schema.properties.receptionist.properties.lines, schema.properties.smallTalk,
    schema.definitions.staffMember.properties.lines, ...Object.values<Json>(schema.properties.lines.properties),
  ].map((p) => p.description as string);
  for (const t of texts) {
    assert.match(t, /about 70 characters/);
    assert.match(t, /ASCII/);
  }
});

/** A structural check of a value against the schema: types, caps, enums, patterns, additionalProperties false. Returns problems. */
function check(value: unknown, node: Json, at: string, root: Json): string[] {
  if (node.$ref) node = { ...resolve(node.$ref, root), ...node, $ref: undefined };
  const out: string[] = [];
  const t = node.type;
  if (t === 'string') {
    if (typeof value !== 'string') return [`${at}: not a string`];
    if (node.minLength !== undefined && value.length < node.minLength) out.push(`${at}: too short`);
    if (node.maxLength !== undefined && value.length > node.maxLength) out.push(`${at}: too long`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) out.push(`${at}: pattern ${node.pattern} fails on ${JSON.stringify(value)}`);
    if (node.enum && !node.enum.includes(value)) out.push(`${at}: not in enum`);
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') out.push(`${at}: not a boolean`);
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${at}: not an array`];
    if (node.minItems !== undefined && value.length < node.minItems) out.push(`${at}: too few items`);
    if (node.maxItems !== undefined && value.length > node.maxItems) out.push(`${at}: too many items`);
    if (node.items) value.forEach((v, i) => out.push(...check(v, node.items, `${at}[${i}]`, root)));
  } else if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${at}: not an object`];
    for (const [k, v] of Object.entries(value)) {
      const sub = node.properties?.[k];
      if (sub) out.push(...check(v, sub, `${at}.${k}`, root));
      else if (node.additionalProperties === false) out.push(`${at}.${k}: unknown key`);
    }
  }
  return out;
}

function resolve(ref: string, root: Json): Json {
  return ref.replace(/^#\//, '').split('/').reduce((n: Json, k) => n[k], root);
}

test('the checker catches the mistakes it is meant to', () => {
  assert.ok(check({ colors: { wall: 'red' } }, schema, 'x', schema).length > 0);
  assert.ok(check({ colors: { nope: '#ffffff' } }, schema, 'x', schema).length > 0);
  assert.ok(check({ lineMode: 'swap' }, schema, 'x', schema).length > 0);
  assert.ok(check({ lines: { bossVisit: ['café'] } }, schema, 'x', schema).length > 0);
  assert.ok(check({ lines: { itFixerTalk: [['one']] } }, schema, 'x', schema).length > 0);
  assert.deepEqual(check({ name: 'Ok', lineMode: 'replace', titles: { manager: 'Boss' }, cleaner: { name: 'A' } }, schema, 'x', schema), []);
});

const presets = fs.readdirSync(path.join(mediaDir, 'themes')).filter((f) => f.endsWith('.theme.json'));

test('there are packaged presets to check', () => {
  assert.ok(presets.length > 0);
});

for (const file of presets) {
  test(`packaged preset ${file} is valid against the schema`, () => {
    const theme = JSON.parse(fs.readFileSync(path.join(mediaDir, 'themes', file), 'utf8'));
    assert.deepEqual(check(theme, schema, file, schema), []);
  });
}
