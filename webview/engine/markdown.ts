/**
 * Markdown-lite: a small, forgiving tokenizer for assistant text and plans.
 * DOM-free (tested with plain Node); `dom.ts` turns the blocks into elements
 * with text nodes only, so nothing here is ever parsed as HTML.
 *
 * Supported: paragraphs (single newlines kept as line breaks), ATX headings,
 * fenced code blocks (an unclosed fence runs to the end, which suits streaming
 * text), bullet and numbered lists (with a little nesting), block quotes,
 * horizontal rules, pipe tables (kept as monospace text), and inline `code`,
 * **bold** / __bold__ and *italic*.
 */

export type MdInline =
  | { t: 'text'; s: string }
  | { t: 'code'; s: string }
  | { t: 'bold'; s: string }
  | { t: 'italic'; s: string };

export interface MdListItem {
  /** Nesting depth, 0 for top level (at most 3). */
  depth: number;
  spans: MdInline[];
}

export type MdBlock =
  | { kind: 'para'; spans: MdInline[] }
  | { kind: 'heading'; level: number; spans: MdInline[] }
  | { kind: 'code'; lang: string; text: string; open?: boolean }
  | { kind: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: 'quote'; spans: MdInline[] }
  | { kind: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE = /^\s*\|.*\|\s*$/;

function indentWidth(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
}

/** Splits text into blocks. Never throws; any input gives some output. */
export function parseBlocks(text: string): MdBlock[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) {
      out.push({ kind: 'para', spans: parseInline(para.join('\n')) });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code.
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1]!;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i]!;
        const t = l.trim();
        if (t.startsWith(marker[0]!.repeat(marker.length)) && /^(`{3,}|~{3,})$/.test(t)) {
          closed = true;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      const block: MdBlock = { kind: 'code', lang, text: body.join('\n') };
      if (!closed) block.open = true;
      out.push(block);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      out.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      out.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (TABLE.test(line)) {
      flushPara();
      const rows: string[] = [];
      while (i < lines.length && TABLE.test(lines[i]!)) rows.push(lines[i++]!.trim());
      out.push({ kind: 'code', lang: 'table', text: rows.join('\n') });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flushPara();
      const q: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!);
        if (!m) break;
        q.push(m[1] ?? '');
        i++;
      }
      out.push({ kind: 'quote', spans: parseInline(q.join('\n')) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = !!ordered;
      const start = ordered ? Number(ordered[2]) : 1;
      const items: MdListItem[] = [];
      const baseIndent = indentWidth((bullet ?? ordered)![1] ?? '');
      let cur: { depth: number; text: string[] } | null = null;
      const push = (): void => {
        if (cur) items.push({ depth: cur.depth, spans: parseInline(cur.text.join('\n')) });
        cur = null;
      };
      while (i < lines.length) {
        const l = lines[i]!;
        const b = BULLET.exec(l);
        const o = b ? null : ORDERED.exec(l);
        const m = b ?? o;
        if (RULE.test(l)) break;
        if (m) {
          // A different list type at the top level starts a new list.
          const ind = indentWidth(m[1] ?? '');
          if (ind <= baseIndent && (!!o) !== isOrdered) break;
          push();
          const depth = Math.max(0, Math.min(3, Math.floor((ind - baseIndent) / 2)));
          cur = { depth, text: [m[3] ?? ''] };
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1];
          if (next !== undefined && (BULLET.test(next) || ORDERED.test(next)) && indentWidth(/^\s*/.exec(next)![0]) >= baseIndent) {
            i++;
            continue;
          }
          break;
        }
        // Continuation of the current item (indented, or lazy).
        if (cur && !HEADING.test(l) && !FENCE.test(l) && !QUOTE.test(l) && !TABLE.test(l)) {
          (cur as { text: string[] }).text.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      push();
      out.push({ kind: 'list', ordered: isOrdered, start, items });
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

/** Splits one paragraph's text into inline spans. Unmatched markers stay as text. */
export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  const pushText = (t: string): void => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.s += t;
    else out.push({ t: 'text', s: t });
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < n && /[\\`*_[\]#>-]/.test(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = s.indexOf(fence, i + run);
      if (end > i) {
        // The closing run must be exactly the same length.
        let e = end;
        while (e >= 0 && s[e + run] === '`') e = s.indexOf(fence, e + run + 1);
        if (e > i) {
          pushText(buf);
          buf = '';
          let code = s.slice(i + run, e);
          if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
          out.push({ t: 'code', s: code });
          i = e + run;
          continue;
        }
      }
      buf += fence;
      i += run;
      continue;
    }
    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const marker = ch + ch;
      const end = s.indexOf(marker, i + 2);
      const inner = end > i + 2 ? s.slice(i + 2, end) : '';
      // `__init__`-style names and snake_case stay as they are.
      const wordy = ch === '_' && (/\w/.test(s[i - 1] ?? '') || /^\w+$/.test(inner) || /\w/.test(s[end + 2] ?? ''));
      if (inner && !/^\s|\s$/.test(inner) && !wordy) {
        pushText(buf);
        buf = '';
        out.push({ t: 'bold', s: inner });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' && s[i + 1] !== '*' && s[i + 1] !== undefined && !/\s/.test(s[i + 1]!)) {
      let end = s.indexOf('*', i + 1);
      while (end > 0 && s[end + 1] === '*') end = s.indexOf('*', end + 2);
      const inner = end > i + 1 ? s.slice(i + 1, end) : '';
      if (inner && !/\s$/.test(inner) && !inner.includes('\n\n')) {
        pushText(buf);
        buf = '';
        out.push({ t: 'italic', s: inner });
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  pushText(buf);
  return out;
}

/** Plain text of some spans (for titles and tests). */
export function spansText(spans: readonly MdInline[]): string {
  return spans.map((x) => x.s).join('');
}
