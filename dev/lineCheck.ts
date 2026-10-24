/**
 * Pure checks for chit-chat lines: does a line fit a speech bubble, can the
 * pixel font draw it, is it a duplicate, does it use a banned term. Used by
 * `dev/check-lines.ts`; no I/O here so tests can import it.
 */
import { SPEECH_BUBBLE_MAX_LINES, TEXT_BUBBLE_MAX_W, wrapText } from '../webview/engine/overlay.ts';
import { measurePixelText } from '../webview/art/font.ts';
import { LINE_POOL_KIND } from '../src/shared/theme.ts';

// TODO: import these from overlay.ts once it exports them (they are private there).
/** Width in pixels speech bubbles wrap text at (overlay.ts TEXT_BUBBLE_MAX_W; chat bubbles carry no icon). */
export const BUBBLE_MAX_W = 84;
/** Most rows a line may need before it counts as not fitting. */
export const MAX_ROWS = 3;
/** Rows beyond which a line only gets a warning. */
export const WARN_ROWS = 2;

/** TV-show names and places (case-insensitive, whole words or phrases). Only names belong here. */
export const SHOW_TERMS: readonly string[] = [
  // TV-show terms
  'dunder', 'mifflin', 'scranton', 'schrute', 'pretzel', 'jello', 'jell-o', 'beet', 'beets', 'dundie', 'dundies',
  "that's what she said", 'assistant to the regional manager', 'sabre', 'stamford', 'nashua',
  'michael', 'dwight', 'jim', 'pam', 'ryan', 'andy', 'angela', 'kevin', 'oscar', 'stanley', 'phyllis', 'meredith',
  'creed', 'toby', 'kelly', 'erin', 'darryl', 'holly', 'jan',
  // Character names from another TV show
  'moss', 'roy', 'jen', 'reynholm', 'denholm', 'douglas', 'richmond',
];

/** AI and tech brands, and real companies and products (case-insensitive, whole words). */
export const BRAND_TERMS: readonly string[] = [
  'claude', 'anthropic', 'openai', 'chatgpt', 'gpt', 'google', 'microsoft', 'excel', 'powerpoint', 'github',
  'netflix', 'starbucks', 'nespresso', 'ikea', 'lego', 'tesco',
];

/** Words banned for house style, not because they name anything: "The user's rule for the IT pair: they never say these". */
export const STYLE_TERMS: readonly string[] = ['slop', 'sloppy'];

/** Every term writers must not use: `SHOW_TERMS`, then `STYLE_TERMS`, then `BRAND_TERMS`. Extend freely. */
export const BANNED_TERMS: readonly string[] = [...SHOW_TERMS, ...STYLE_TERMS, ...BRAND_TERMS];

/** Capitalised words that are fine mid-sentence. */
export const CAPS_ALLOWLIST: readonly string[] = [
  'I', "I'm", "I'll", "I've", "I'd", 'OK', 'AM', 'PM', 'AI', 'PR', 'PRs', 'CI', 'UK', 'TV', 'USB', 'HR', 'IT', 'QA', 'API', 'CSS', 'HTML',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Christmas', 'Easter', 'Halloween', 'Friday', 'Mondays', 'Fridays',
];

/** Everything a pool can be: a line pool or a pair pool. */
export interface Pool { name: string; kind: 'lines' | 'pairs'; lines: string[]; pairs: [string, string][] }

/** One problem found in one line. */
export interface Finding { severity: 'error' | 'warning'; pool: string; index: number; text: string; message: string }

/** Rows `text` needs in a speech bubble (real wrapping, no truncation). */
export function rowsNeeded(text: string, maxW = BUBBLE_MAX_W): number {
  return wrapText(text, maxW, 99).length;
}

/** True when a single word is wider than the bubble (the wrapper would break it mid-word). */
export function hasOverlongWord(text: string, maxW = BUBBLE_MAX_W): string | null {
  for (const w of text.split(/\s+/).filter(Boolean)) if (measurePixelText(w).w > maxW) return w;
  return null;
}

/** Characters the pixel font has no glyph for (it covers printable ASCII 32-126 and draws `?` otherwise). */
export function missingGlyphs(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 32 || c > 126) out.push(ch);
  }
  return out;
}

/** Lower-case, strip punctuation, collapse spaces. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/** Fit and glyph errors for one line (the only checks presets get). */
export function checkFit(text: string, pool: string, index: number): Finding[] {
  const f: Finding[] = [];
  const mk = (message: string): Finding => ({ severity: 'error', pool, index, text, message });
  const rows = rowsNeeded(text);
  if (rows > MAX_ROWS) f.push(mk(`needs ${rows} rows (max ${MAX_ROWS})`));
  const long = hasOverlongWord(text);
  if (long) f.push(mk(`word "${long}" is wider than the bubble`));
  const miss = missingGlyphs(text);
  if (miss.length) f.push(mk(`no glyph for ${[...new Set(miss)].map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`).join(', ')}`));
  return f;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const BANNED_RES = BANNED_TERMS.map((t) => ({ t, re: new RegExp(`(?<![\\p{L}\\p{N}'])${escapeRe(t.replace(/’/g, "'"))}(?![\\p{L}\\p{N}])`, 'iu') }));
const GENDER_RE = /\b(he|she|him|her|his|hers)\b/i;

/** Banned terms found in `text`. */
export function bannedIn(text: string): string[] {
  const t = text.replace(/’/g, "'");
  return BANNED_RES.filter(({ re }) => re.test(t)).map(({ t: term }) => term);
}

/** Capitalised words that are neither a sentence start nor on the allowlist. */
export function oddCaps(text: string): string[] {
  const out: string[] = [];
  const allow = new Set(CAPS_ALLOWLIST);
  const tokens = text.split(/\s+/).filter(Boolean);
  let start = true;
  for (const tok of tokens) {
    const word = tok.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, '');
    if (!start && /^[A-Z]/.test(word) && !allow.has(word) && !/^[A-Z]+$/.test(word)) out.push(word);
    start = /[.!?]["')]*$/.test(tok);
  }
  return out;
}

/** Every check on one speech line: fit and glyphs, banned terms, then the warnings (wrapping, gendered words, odd capitals). */
export function checkLine(text: string, pool: string, index: number): Finding[] {
  const f = checkFit(text, pool, index);
  const add = (severity: Finding['severity'], message: string): void => {
    f.push({ severity, pool, index, text, message });
  };
  for (const b of bannedIn(text)) add('error', `banned term "${b}"`);
  if (rowsNeeded(text) > WARN_ROWS && rowsNeeded(text) <= MAX_ROWS) add('warning', `wraps to ${rowsNeeded(text)} rows (aim for ${WARN_ROWS})`);
  const g = text.match(GENDER_RE);
  if (g) add('warning', `gendered word "${g[0]}"`);
  const caps = oddCaps(text);
  if (caps.length) add('warning', `capitalised mid-sentence: ${caps.join(', ')} (name or brand?)`);
  return f;
}

/** Full set of checks for a writer's pools: errors and warnings, duplicates across all pools given. */
export function checkPools(pools: Pool[]): Finding[] {
  const f: Finding[] = [];
  // Every normalised text seen so far, wherever it was (opener, reply or plain line, any pool) and where.
  const seen = new Map<string, string>();
  const seenPair = new Map<string, string>();
  for (const p of pools) {
    if (p.kind === 'lines') {
      p.lines.forEach((text, i) => {
        f.push(...checkLine(text, p.name, i));
        const k = normalise(text);
        const prev = seen.get(k);
        if (prev) f.push({ severity: 'error', pool: p.name, index: i, text, message: `duplicate text (also ${prev})` });
        else seen.set(k, `${p.name}[${i}]`);
      });
    } else {
      p.pairs.forEach(([a, b], i) => {
        f.push(...checkLine(a, p.name, i), ...checkLine(b, p.name, i));
        const where = `${p.name}[${i}]`;
        const pair = `${normalise(a)}|${normalise(b)}`;
        const text = `${a} / ${b}`;
        const prevPair = seenPair.get(pair);
        if (prevPair) {
          f.push({ severity: 'error', pool: p.name, index: i, text, message: `duplicate pair (also ${prevPair})` });
          return;
        }
        seenPair.set(pair, where);
        // One error per pair, naming every text of it that is already used elsewhere (or twice within it).
        const clashes: string[] = [];
        for (const [role, t] of [['opener', a], ['reply', b]] as const) {
          const k = normalise(t);
          const prev = seen.get(k);
          if (prev) clashes.push(`${role} "${t}" (also ${prev})`);
          else seen.set(k, where);
        }
        if (clashes.length) f.push({ severity: 'error', pool: p.name, index: i, text, message: `duplicate text: ${clashes.join('; ')}` });
      });
    }
  }
  return f;
}

/** Classifies an exported value as a line pool, a pair pool, or neither. */
export function toPool(name: string, value: unknown): Pool | null {
  if (!Array.isArray(value)) return null;
  if (value.every((v) => typeof v === 'string')) return { name, kind: 'lines', lines: value as string[], pairs: [] };
  if (value.every((v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string')) {
    return { name, kind: 'pairs', lines: [], pairs: value as [string, string][] };
  }
  return null;
}

/** The shape of a theme file this checker reads (a subset of the real theme). */
export interface PresetLike {
  name?: string; description?: string;
  titles?: Record<string, string>;
  lines?: Record<string, unknown>;
  company?: string; branch?: string;
  manager?: { name?: string; lines?: string[] }; receptionist?: { name?: string; lines?: string[] };
  staff?: { name?: string; role?: string; lines?: string[] }[];
  temps?: { name?: string }[];
  smallTalk?: [string, string][];
  cleaner?: { name?: string }; vendor?: { name?: string }; itFixer?: { name?: string }; itCritic?: { name?: string };
}

/** One problem in a theme file. `path` is where it sits, e.g. `lines.cleanerMutters[3]` or `titles.manager`. */
export interface PresetFinding { severity: 'error' | 'warning'; path: string; text: string; message: string }

/** Every speech string of a preset, with its path and its checks. Pairs give two strings: `lines.itFixerTalk[2][0]` and `[1]`. */
export function checkPresetSpeech(t: PresetLike): { path: string; text: string; findings: PresetFinding[] }[] {
  const out: { path: string; text: string; findings: PresetFinding[] }[] = [];
  const bad = (path: string, text: string, message: string): PresetFinding[] => [{ severity: 'error', path, text, message }];
  const speech = (path: string, text: unknown): void => {
    if (typeof text !== 'string') out.push({ path, text: String(text), findings: bad(path, String(text), 'not a string') });
    else out.push({ path, text, findings: checkLine(text, path, 0).map(({ severity, message }) => ({ severity, path, text, message })) });
  };
  (t.smallTalk ?? []).forEach((pr, i) => pr.forEach((text, j) => speech(`smallTalk[${i}][${j}]`, text)));
  (t.manager?.lines ?? []).forEach((text, i) => speech(`manager.lines[${i}]`, text));
  (t.receptionist?.lines ?? []).forEach((text, i) => speech(`receptionist.lines[${i}]`, text));
  (t.staff ?? []).forEach((s, si) => (s.lines ?? []).forEach((text, i) => speech(`staff[${si}].lines[${i}]`, text)));
  for (const [key, value] of Object.entries(t.lines ?? {})) {
    const path = `lines.${key}`;
    const kind = (LINE_POOL_KIND as Record<string, 'lines' | 'pairs' | undefined>)[key];
    if (!kind) {
      out.push({ path, text: '', findings: bad(path, '', 'unknown line pool') });
      continue;
    }
    if (!Array.isArray(value)) {
      out.push({ path, text: '', findings: bad(path, '', 'expected an array') });
      continue;
    }
    value.forEach((entry, i) => {
      if (kind === 'lines') speech(`${path}[${i}]`, entry);
      else if (Array.isArray(entry) && entry.length === 2) entry.forEach((text, j) => speech(`${path}[${i}][${j}]`, text));
      else out.push({ path: `${path}[${i}]`, text: JSON.stringify(entry), findings: bad(`${path}[${i}]`, JSON.stringify(entry), 'not an [opener, reply] pair') });
    });
  }
  return out;
}

/** Banned terms and non-ASCII for a short name or title. Not speech, so no fit or length rules (those are `THEME_LIMITS`). */
export function checkShortText(text: string, path: string): PresetFinding[] {
  const f: PresetFinding[] = [];
  for (const b of bannedIn(text)) f.push({ severity: 'error', path, text, message: `banned term "${b}"` });
  const odd = [...new Set(text.match(/[^\x20-\x7e]/g) ?? [])];
  if (odd.length) f.push({ severity: 'error', path, text, message: `non-ASCII ${odd.map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`).join(', ')}` });
  return f;
}

/** Every finding for a theme preset: its speech lines, then its titles, names and description. */
export function checkPreset(t: PresetLike): { lines: number; findings: PresetFinding[] } {
  const speech = checkPresetSpeech(t);
  const short: [string, unknown][] = [
    ['name', t.name], ['description', t.description],
    ...Object.entries(t.titles ?? {}).map(([k, v]): [string, unknown] => [`titles.${k}`, v]),
    ...(['cleaner', 'vendor', 'itFixer', 'itCritic'] as const).map((k): [string, unknown] => [`${k}.name`, t[k]?.name]),
    ['company', t.company], ['branch', t.branch], ['manager.name', t.manager?.name], ['receptionist.name', t.receptionist?.name],
    ...(t.staff ?? []).flatMap((s, i): [string, unknown][] => [[`staff[${i}].name`, s.name], [`staff[${i}].role`, s.role]]),
    ...(t.temps ?? []).map((s, i): [string, unknown] => [`temps[${i}].name`, s.name]),
  ];
  const findings = [
    ...speech.flatMap((l) => l.findings),
    ...short.flatMap(([path, v]) => (typeof v === 'string' ? checkShortText(v, path) : [])),
  ];
  return { lines: speech.length, findings };
}
