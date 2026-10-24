/**
 * A generic poller for one file: while started it stats the file every `intervalMs` (a setTimeout chain, so polls never
 * overlap) and, when the modified time or size changed, reads it and calls `onChange(text)`. A missing file calls
 * `onChange(undefined)` once, when it first goes missing (or is missing at the first poll). No vscode, fs and timers injected.
 */
export interface FilePollerDeps {
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(path: string): Promise<string>;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  log?(msg: string): void;
}

export interface FilePollerOptions {
  path: string;
  intervalMs: number;
  /** Called with the new text, or undefined when the file is missing. Exceptions are caught and logged. */
  onChange: (text: string | undefined) => void;
  /** Files larger than this are not read (and not reported); the poller keeps watching. Default: no cap. */
  maxBytes?: number;
}

export class FilePoller {
  private readonly deps: FilePollerDeps;
  private readonly opts: FilePollerOptions;
  private running = false;
  private gen = 0;
  private timer: unknown;
  private lastSig: string | undefined;

  constructor(deps: FilePollerDeps, opts: FilePollerOptions) {
    this.deps = deps;
    this.opts = opts;
  }

  get started(): boolean {
    return this.running;
  }

  /** Begin polling (first check at once). Starting twice does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.gen, 0);
  }

  /** Stop polling. A read in flight is discarded without calling `onChange`. Starting again re-checks the file (and reports it). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.gen++;
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(gen: number, ms: number): void {
    this.timer = this.deps.timers.setTimeout(() => void this.pollOnce(gen), ms);
  }

  private async pollOnce(gen: number): Promise<void> {
    if (gen !== this.gen) return;
    this.timer = undefined;
    try {
      let sig: string;
      let size = 0;
      try {
        const st = await this.deps.stat(this.opts.path);
        sig = `${st.mtimeMs}:${st.size}`;
        size = st.size;
      } catch {
        sig = 'missing';
      }
      if (gen !== this.gen) return;
      if (sig !== this.lastSig) {
        if (sig === 'missing') {
          this.lastSig = sig;
          this.emit(undefined);
        } else if (this.opts.maxBytes !== undefined && size > this.opts.maxBytes) {
          this.lastSig = sig;
          this.deps.log?.(`filePoller: ${this.opts.path} is larger than ${this.opts.maxBytes} bytes, skipped`);
        } else {
          let text: string | undefined;
          try {
            text = await this.deps.readFile(this.opts.path);
          } catch {
            text = undefined; // vanished or unreadable between stat and read: retry next poll
          }
          if (gen !== this.gen) return;
          if (text !== undefined) {
            this.lastSig = sig;
            this.emit(text);
          }
        }
      }
    } catch (e) {
      this.deps.log?.(`filePoller: poll failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (gen === this.gen && this.running) this.schedule(gen, this.opts.intervalMs);
    }
  }

  private emit(text: string | undefined): void {
    try {
      this.opts.onChange(text);
    } catch (e) {
      this.deps.log?.(`filePoller: onChange threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
