// The user's Claude Code defaults for the webview ("Default (Opus · xhigh)" on the memo, the effort pip rules): the whitelisted
// keys of `~/.claude/settings.json` (`parseClaudeDefaults`, with the two allowed env variables) plus the model list the usage
// probe reads from the SDK (`onProbeOk` -> `setModels`). Polls the settings file every 5 s while the office is visible
// (`FilePoller`) and posts `{ type: 'claudeDefaults' }` only when the combined value changed.
//
// No `vscode` import. The fs, timers, env and post function are injected. Logs carry counts only, never file content.
import { parseClaudeDefaults, parseJsonText } from '../claude/claudeConfig.ts';
import { LIMITS } from '../shared/protocol.ts';
import type { ClaudeDefaults, HostToWebview, ModelChoice } from '../shared/protocol.ts';
import { FilePoller } from './filePoller.ts';

export const SETTINGS_POLL_MS = 5_000;
/** A real `settings.json` is a few KB; refuse anything over this without reading it. */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

export interface ClaudeDefaultsDeps {
  post: (msg: Extract<HostToWebview, { type: 'claudeDefaults' }>) => void;
  fs: { stat(path: string): Promise<{ mtimeMs: number; size: number }>; readFile(path: string): Promise<string> };
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** `claudeSettingsJsonPath()`. */
  settingsPath: string;
  /** The process env. Only `ANTHROPIC_MODEL` and `CLAUDE_CODE_EFFORT_LEVEL` are ever read from it (by `parseClaudeDefaults`). */
  env?: () => Record<string, string | undefined>;
  log?: (msg: string) => void;
}

/** Combine the parsed settings, the env and the model list into the message payload. Pure. */
export function combineClaudeDefaults(settingsJson: unknown, env: Record<string, string | undefined>, models: readonly ModelChoice[] | undefined): ClaudeDefaults {
  const out = parseClaudeDefaults(settingsJson, env);
  if (models !== undefined && models.length > 0) out.models = models.slice(0, LIMITS.models).map((m) => ({ ...m, ...(m.efforts === undefined ? {} : { efforts: [...m.efforts] }) }));
  return out;
}

export class ClaudeDefaultsService {
  readonly #deps: ClaudeDefaultsDeps;
  readonly #poller: FilePoller;
  /** The last good parse of settings.json; undefined while the file is missing (or was never good). */
  #settings: unknown;
  #models: ModelChoice[] | undefined;
  #lastPosted: string | undefined;

  constructor(deps: ClaudeDefaultsDeps) {
    this.#deps = deps;
    this.#poller = new FilePoller(
      { stat: deps.fs.stat, readFile: deps.fs.readFile, timers: deps.timers, log: deps.log },
      { path: deps.settingsPath, intervalMs: SETTINGS_POLL_MS, maxBytes: MAX_SETTINGS_BYTES, onChange: (text) => this.#onText(text) },
    );
  }

  /** The office became visible (start polling, which reads the file at once) or hidden (stop; no timers at all). */
  setVisible(visible: boolean): void {
    if (visible) this.#poller.start();
    else this.#poller.stop();
  }

  /** A probe succeeded: remember its model list (an empty list keeps the earlier one) and republish when it changed. */
  setModels(models: readonly ModelChoice[]): void {
    if (models.length === 0) return;
    this.#models = models.map((m) => ({ ...m }));
    this.#emit();
  }

  /** The current combined value (for tests and replay). */
  current(): ClaudeDefaults {
    return combineClaudeDefaults(this.#settings, this.#deps.env?.() ?? {}, this.#models);
  }

  dispose(): void {
    this.#poller.stop();
  }

  #onText(text: string | undefined): void {
    if (text === undefined) {
      this.#settings = undefined; // no settings.json: only the env (and the models) apply
    } else {
      const parsed = parseJsonText(text, MAX_SETTINGS_BYTES);
      if (parsed.ok) this.#settings = parsed.value;
      else this.#deps.log?.(`claudeDefaults: settings unreadable (${parsed.reason}); keeping the last good values`);
    }
    this.#emit();
  }

  #emit(): void {
    const defaults = this.current();
    const key = JSON.stringify(defaults);
    if (key === this.#lastPosted) return;
    this.#lastPosted = key;
    try {
      this.#deps.post({ type: 'claudeDefaults', defaults });
    } catch (e) {
      this.#deps.log?.(`claudeDefaults: post failed: ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}
