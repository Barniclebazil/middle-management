import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, spansText } from '../webview/engine/markdown.ts';

test('paragraphs split on blank lines and keep single newlines', () => {
  const b = parseBlocks('Hello there.\nSecond line.\n\nNew para.');
  assert.equal(b.length, 2);
  assert.ok(b[0]!.kind === 'para' && spansText(b[0]!.spans) === 'Hello there.\nSecond line.');
  assert.ok(b[1]!.kind === 'para' && spansText(b[1]!.spans) === 'New para.');
});

test('inline code, bold and italic', () => {
  assert.deepEqual(parseInline('Run `npm test` then **ship** it *now*.'), [
    { t: 'text', s: 'Run ' }, { t: 'code', s: 'npm test' }, { t: 'text', s: ' then ' }, { t: 'bold', s: 'ship' },
    { t: 'text', s: ' it ' }, { t: 'italic', s: 'now' }, { t: 'text', s: '.' },
  ]);
  assert.deepEqual(parseInline('a ``b ` c`` d'), [{ t: 'text', s: 'a ' }, { t: 'code', s: 'b ` c' }, { t: 'text', s: ' d' }]);
  assert.deepEqual(parseInline('__init__ and snake_case_name stay'), [{ t: 'text', s: '__init__ and snake_case_name stay' }]);
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ t: 'text', s: '2 * 3 * 4' }], 'spaced asterisks are not italic');
  assert.deepEqual(parseInline('unclosed `tick and **bold'), [{ t: 'text', s: 'unclosed `tick and **bold' }]);
  assert.deepEqual(parseInline('\\*not italic\\*'), [{ t: 'text', s: '*not italic*' }]);
});

test('markup-looking text stays text (rendered with text nodes)', () => {
  const b = parseBlocks('<img src=x onerror=alert(1)> & <b>hi</b>');
  assert.deepEqual(b, [{ kind: 'para', spans: [{ t: 'text', s: '<img src=x onerror=alert(1)> & <b>hi</b>' }] }]);
});

test('fenced code blocks, closed and open (streaming)', () => {
  const b = parseBlocks('Before\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nAfter');
  assert.deepEqual(b.map((x) => x.kind), ['para', 'code', 'para']);
  assert.deepEqual(b[1], { kind: 'code', lang: 'ts', text: 'const a = 1;\n\nconst b = 2;' });
  const open = parseBlocks('```bash\nnpm run');
  assert.deepEqual(open, [{ kind: 'code', lang: 'bash', text: 'npm run', open: true }]);
  const tilde = parseBlocks('~~~\nx\n~~~');
  assert.deepEqual(tilde, [{ kind: 'code', lang: '', text: 'x' }]);
});

test('bullet and numbered lists with nesting and continuation', () => {
  const b = parseBlocks('- one\n- two\n  more of two\n  - nested\n\n1. first\n2. second');
  assert.equal(b.length, 2);
  const ul = b[0]!;
  assert.equal(ul.kind, 'list');
  if (ul.kind !== 'list') return;
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.items.map((i) => [i.depth, spansText(i.spans)]), [[0, 'one'], [0, 'two\nmore of two'], [1, 'nested']]);
  const ol = b[1]!;
  assert.ok(ol.kind === 'list' && ol.ordered && ol.start === 1 && ol.items.length === 2);
});

test('a loose list (blank lines between items) stays one list', () => {
  const b = parseBlocks('* a\n\n* b\n\nText');
  assert.deepEqual(b.map((x) => x.kind), ['list', 'para']);
  assert.ok(b[0]!.kind === 'list' && b[0]!.items.length === 2);
});

test('headings, rules, quotes and tables', () => {
  const b = parseBlocks('## Plan\n---\n> careful\n> now\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.deepEqual(b.map((x) => x.kind), ['heading', 'rule', 'quote', 'code']);
  assert.ok(b[0]!.kind === 'heading' && b[0]!.level === 2 && spansText(b[0]!.spans) === 'Plan');
  assert.ok(b[2]!.kind === 'quote' && spansText(b[2]!.spans) === 'careful\nnow');
  assert.ok(b[3]!.kind === 'code' && b[3]!.lang === 'table' && b[3]!.text.split('\n').length === 3);
});

test('odd input never throws', () => {
  for (const s of ['', '\n\n', '```', '- ', '#', '**', '`', '1.', '> ', '|', '\r\n\r\n', 'a'.repeat(5000)]) {
    assert.doesNotThrow(() => parseBlocks(s));
  }
  assert.deepEqual(parseBlocks(''), []);
});
