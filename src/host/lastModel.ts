// Finds the model a session last used from the tail of its transcript. No `vscode` import.
import { open } from 'node:fs/promises';

/** Read the last `maxBytes` of a file as text (first partial line dropped). Missing or unreadable gives ''. */
export async function readTailText(file: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await handle.read(buf, got, length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    let text = buf.subarray(0, got).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    try {
      await handle?.close();
    } catch {
      // ignore
    }
  }
}

/** The `message.model` of the last assistant record in JSONL text, ignoring synthetic placeholders. */
export function lastModelInTranscript(jsonl: string): string | undefined {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t === '' || !t.includes('"assistant"')) continue;
    try {
      const rec = JSON.parse(t) as { type?: unknown; message?: { model?: unknown } };
      const m = rec.message?.model;
      if (rec.type === 'assistant' && typeof m === 'string' && m !== '' && !m.startsWith('<')) return m;
    } catch {
      // partial or corrupt line
    }
  }
  return undefined;
}
