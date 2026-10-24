// Reads the tail of a Claude Code transcript (JSONL) and converts it to conversation items.
// No vscode; uses fs.promises only.
import { open } from 'node:fs/promises';
import { LIMITS } from '../shared/protocol.ts';
import type { ConversationItem } from '../shared/protocol.ts';
import { itemsFromTranscript } from './conversation.ts';

export interface ReadTailOptions {
  /** Bytes to read from the end of the file (default 1 MB). */
  maxBytes?: number;
  /** Keep at most this many items (default and ceiling LIMITS.caseItems). */
  maxItems?: number;
  /** Subagent transcript: include sidechain records. */
  sidechain?: boolean;
}

export interface TailResult { items: ConversationItem[]; truncated: boolean }

const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Parse JSONL text, skipping blank and unparseable lines. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial or corrupt line
    }
  }
  return out;
}

/** Read the last `maxBytes` of `file` and convert. A missing or unreadable file gives an empty result. */
export async function readTail(file: string, opts: ReadTailOptions = {}): Promise<TailResult> {
  let handle;
  try {
    const maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return { items: [], truncated: false };
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await handle.read(buf, got, length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    let text = buf.subarray(0, got).toString('utf8');
    if (start > 0) {
      // Drop the first (partial) line.
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    const res = itemsFromTranscript(parseJsonl(text), {
      sidechain: opts.sidechain === true,
      maxItems: opts.maxItems ?? LIMITS.caseItems,
    });
    return { items: res.items, truncated: res.truncated || (start > 0 && res.items.length > 0) };
  } catch {
    return { items: [], truncated: false };
  } finally {
    try {
      await handle?.close();
    } catch {
      // ignore
    }
  }
}

export interface CaseAgent {
  id: string;
  kind: string;
  sessionId?: string;
}

/**
 * Read the case file items for an agent. `locate` maps the agent to its transcript path
 * (the session file for a main worker, the subagent file for a temp).
 */
export async function readCaseFor(
  agent: CaseAgent,
  locate: (agent: CaseAgent) => string | undefined,
  opts: Omit<ReadTailOptions, 'sidechain'> = {},
): Promise<TailResult> {
  let file: string | undefined;
  try {
    file = locate(agent);
  } catch {
    file = undefined;
  }
  if (!file) return { items: [], truncated: false };
  return readTail(file, { ...opts, sidechain: agent.kind === 'temp' });
}
