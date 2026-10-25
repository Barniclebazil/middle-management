import type { Activity } from '../shared/protocol.ts';

/** What a tool call looks like in the office: a pose plus a few words for the speech bubble. */
export interface ToolClass { activity: Activity; detail?: string }

/** Longest detail string (speech bubble text), ellipsis included. */
export const MAX_DETAIL = 32;

/** File extensions that make an Edit/Write count as drawing rather than writing. */
const DRAWING_EXTENSIONS: ReadonlySet<string> = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.drawio', '.excalidraw', '.fig',
]);

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const RUN_TOOLS: ReadonlySet<string> = new Set(['Bash', 'BashOutput', 'KillShell', 'Monitor', 'PowerShell', 'TaskOutput', 'TaskStop']);
const PLAN_TOOLS: ReadonlySet<string> = new Set(['EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);

const MCP_RESEARCH = /browser|fetch|search|web/;
const MCP_DRAWING = /image|design|figma|canvas|draw|diagram|slide/;

function asRecord(x: unknown): Record<string, unknown> | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

function field(input: unknown, key: string): string | undefined {
  const v = asRecord(input)?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Last path segment; understands both `/` and `\`. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1]! : '';
}

/** Collapse whitespace and cut to `max` characters, ending in an ellipsis when something was cut. */
export function shorten(s: string, max: number = MAX_DETAIL): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : t;
}

function extension(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname || shorten(url);
  } catch {
    return shorten(url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? url);
  }
}

/** `mcp__server__tool` becomes `tool`. */
function shortToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts[parts.length - 1] || name;
  }
  return name;
}

function filePath(input: unknown): string | undefined {
  return field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path');
}

function pathDetail(input: unknown): string | undefined {
  const p = filePath(input);
  if (p === undefined) return undefined;
  const b = basename(p);
  return shorten(b === '' ? p : b);
}

function quoted(s: string): string {
  return '"' + shorten(s, MAX_DETAIL - 2) + '"';
}

function commandDetail(input: unknown): string | undefined {
  const d = field(input, 'description');
  if (d !== undefined) return shorten(d);
  const c = field(input, 'command');
  if (c === undefined) return undefined;
  const flat = c.replace(/\s+/g, ' ').trim();
  return flat.length > 30 ? flat.slice(0, 30).trimEnd() + '…' : flat;
}

function todoDetail(input: unknown): string | undefined {
  const todos = asRecord(input)?.['todos'];
  if (!Array.isArray(todos)) return undefined;
  for (const t of todos) {
    const r = asRecord(t);
    if (r !== undefined && r['status'] === 'in_progress') {
      const v = r['activeForm'] ?? r['content'];
      if (typeof v === 'string' && v.trim() !== '') return shorten(v);
    }
  }
  return undefined;
}

function questionDetail(input: unknown): string | undefined {
  const qs = asRecord(input)?.['questions'];
  const first = Array.isArray(qs) ? asRecord(qs[0]) : undefined;
  const v = first?.['header'] ?? first?.['question'] ?? asRecord(input)?.['question'];
  return typeof v === 'string' && v.trim() !== '' ? shorten(v) : undefined;
}

function opt(activity: Activity, detail: string | undefined): ToolClass {
  return detail === undefined || detail === '' ? { activity } : { activity, detail };
}

/** Maps a tool call to the activity it looks like in the office. Never throws. */
export function classifyTool(name: string, input: unknown): ToolClass {
  try {
    return classify(typeof name === 'string' ? name : '', input);
  } catch {
    return { activity: 'writing' };
  }
}

function classify(name: string, input: unknown): ToolClass {
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return opt('reading', pathDetail(input));
    case 'Grep': {
      const p = field(input, 'pattern');
      return opt('searching', p === undefined ? undefined : quoted(p));
    }
    case 'Glob': {
      const p = field(input, 'pattern');
      return opt('searching', p === undefined ? undefined : shorten(p));
    }
    case 'LS':
      return opt('searching', pathDetail(input));
    case 'ToolSearch': {
      const q = field(input, 'query');
      return opt('searching', q === undefined ? undefined : shorten(q.replace(/^select:/, '')));
    }
    case 'WebSearch': {
      const q = field(input, 'query');
      return opt('researching', q === undefined ? undefined : shorten(q));
    }
    case 'WebFetch': {
      const u = field(input, 'url');
      return opt('researching', u === undefined ? undefined : shorten(hostname(u)));
    }
    case 'Artifact':
      return opt('drawing', pathDetail(input));
    case 'TodoWrite':
      return opt('planning', todoDetail(input));
    case 'Skill': {
      const s = field(input, 'skill') ?? field(input, 'name');
      return opt('planning', s === undefined ? undefined : shorten(s));
    }
    case 'Agent':
    case 'Task':
      return opt('delegating', field(input, 'description') === undefined ? undefined : shorten(field(input, 'description')!));
    case 'SendMessage': {
      const d = field(input, 'summary') ?? field(input, 'to');
      return opt('delegating', d === undefined ? undefined : shorten(d));
    }
    case 'AskUserQuestion':
      return opt('needsYou', questionDetail(input));
    default:
      break;
  }
  if (EDIT_TOOLS.has(name)) {
    const p = filePath(input);
    const drawing = p !== undefined && DRAWING_EXTENSIONS.has(extension(p));
    return opt(drawing ? 'drawing' : 'writing', pathDetail(input));
  }
  if (RUN_TOOLS.has(name)) return opt('running', commandDetail(input));
  if (PLAN_TOOLS.has(name)) {
    const d = field(input, 'subject') ?? field(input, 'activeForm');
    return opt('planning', d === undefined ? undefined : shorten(d));
  }
  if (name.startsWith('mcp__')) {
    const lower = name.toLowerCase();
    if (lower.startsWith('mcp__claude-in-chrome__') || MCP_RESEARCH.test(lower)) {
      const u = field(input, 'url');
      return opt('researching', u !== undefined ? shorten(hostname(u)) : shorten(shortToolName(name)));
    }
    if (MCP_DRAWING.test(lower)) return opt('drawing', shorten(shortToolName(name)));
  }
  return opt('writing', name === '' ? undefined : shorten(shortToolName(name)));
}
