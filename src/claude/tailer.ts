import * as fs from 'node:fs';

/** On first sight of a file only this many trailing bytes are parsed. */
export const INITIAL_WINDOW_BYTES = 192 * 1024;
/** Most bytes read from one file in one call; the rest is picked up by the next call. */
export const MAX_READ_BYTES = 16 * 1024 * 1024;
/** A single unterminated line longer than this is dropped rather than buffered. */
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const FINGERPRINT_BYTES = 64;
const NEWLINE = 0x0a;

export interface TailResult {
  records: unknown[];
  /** True when the file was first seen or was rewritten: earlier state for it is invalid. */
  reset: boolean;
}

/**
 * Incremental reader for one append-only .jsonl file. Each `read()` returns only the complete lines
 * added since the previous call. Bytes after the last newline are held back until the newline arrives.
 * Buffering is done on bytes, so a multi-byte UTF-8 character split across reads is decoded intact.
 */
export class JsonlTailer {
  readonly path: string;
  /** Modification time seen by the latest successful stat (0 until the file has been seen). */
  mtimeMs = 0;

  #initialised = false;
  /** File position of the next byte to read. */
  #offset = 0;
  /** Bytes read after the last newline: a line that is still being written. */
  #pending: Buffer = Buffer.alloc(0);
  /** True while skipping the first (partial) line of the initial window. */
  #discarding = false;
  #lastSize = -1;
  #lastMtimeMs = -1;
  #fingerprint: Buffer | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<TailResult> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(this.path);
    } catch (e) {
      if (isMissing(e)) return { records: [], reset: false };
      throw e;
    }
    this.mtimeMs = st.mtimeMs;
    if (
      this.#initialised &&
      st.size === this.#lastSize &&
      st.mtimeMs === this.#lastMtimeMs &&
      this.#offset >= st.size
    ) {
      return { records: [], reset: false };
    }

    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.path, 'r');
    } catch (e) {
      if (isMissing(e)) return { records: [], reset: false };
      throw e;
    }
    try {
      const fst = await fh.stat();
      let reset = !this.#initialised;
      if (!reset && (fst.size < this.#lastSize || !(await this.#fingerprintMatches(fh)))) {
        reset = true;
      }
      if (reset) this.#startOver(fst.size);
      await this.#refreshFingerprint(fh, fst.size);

      const records = await this.#readFrom(fh);
      this.#initialised = true;
      this.#lastSize = fst.size;
      this.#lastMtimeMs = fst.mtimeMs;
      this.mtimeMs = fst.mtimeMs;
      return { records, reset };
    } finally {
      await fh.close();
    }
  }

  /** Positions the reader at the start of the last INITIAL_WINDOW_BYTES of a file of `size` bytes. */
  #startOver(size: number): void {
    this.#pending = Buffer.alloc(0);
    this.#fingerprint = null;
    const start = Math.max(0, size - INITIAL_WINDOW_BYTES);
    if (start > 0) {
      // Start one byte early so a window that begins exactly on a line boundary keeps its first line.
      this.#offset = start - 1;
      this.#discarding = true;
    } else {
      this.#offset = 0;
      this.#discarding = false;
    }
  }

  async #fingerprintMatches(fh: fs.promises.FileHandle): Promise<boolean> {
    const fp = this.#fingerprint;
    if (fp === null || fp.length === 0) return true;
    const buf = Buffer.alloc(fp.length);
    const { bytesRead } = await fh.read(buf, 0, fp.length, 0);
    return bytesRead === fp.length && buf.equals(fp);
  }

  async #refreshFingerprint(fh: fs.promises.FileHandle, size: number): Promise<void> {
    const want = Math.min(FINGERPRINT_BYTES, size);
    if (this.#fingerprint !== null && this.#fingerprint.length >= want && want > 0) return;
    if (want === 0) {
      this.#fingerprint = null;
      return;
    }
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    this.#fingerprint = Buffer.from(buf.subarray(0, bytesRead));
  }

  async #readFrom(fh: fs.promises.FileHandle): Promise<unknown[]> {
    const records: unknown[] = [];
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    while (total < MAX_READ_BYTES) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK_BYTES, this.#offset);
      if (bytesRead === 0) break;
      this.#offset += bytesRead;
      total += bytesRead;
      let data = chunk.subarray(0, bytesRead);

      if (this.#discarding) {
        const nl = data.indexOf(NEWLINE);
        if (nl < 0) continue;
        data = data.subarray(nl + 1);
        this.#discarding = false;
      }
      if (this.#pending.length > 0) data = Buffer.concat([this.#pending, data]);

      const last = data.lastIndexOf(NEWLINE);
      if (last < 0) {
        this.#pending = Buffer.from(data);
      } else {
        const text = data.toString('utf8', 0, last);
        this.#pending = Buffer.from(data.subarray(last + 1));
        parseLines(text, records);
      }
      if (this.#pending.length > MAX_PENDING_BYTES) {
        this.#pending = Buffer.alloc(0);
        this.#discarding = true;
      }
    }
    return records;
  }
}

function parseLines(text: string, out: unknown[]): void {
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line that is not valid JSON is skipped.
    }
  }
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
