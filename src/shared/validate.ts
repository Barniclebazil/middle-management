import { CATALOG_SECTIONS, LOOK_ID_PATTERN, EFFORT_LEVELS, FRONT_DESK_BOOLEAN_SETTINGS, FRONT_DESK_ENUM_VALUES, FRONT_DESK_SETTINGS, FRONT_DESK_TEXT_SETTINGS, LIMITS, PERMISSION_MODES, THEME_ACTIONS, UPDATE_ACTIONS } from './protocol.ts';
import type { AssignTarget, CaseTabBoot, CatalogSection, DecisionPayload, EffortLevel, FrontDeskSettingKey, PermissionMode, SessionOptions, ThemeActionKind, UpdateAction, WebviewToHost } from './protocol.ts';

/** Pure validation of untrusted webview messages. Never throws; returns a freshly built object (extra keys dropped). */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A string with 1..max chars and no NUL. */
function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length >= 1 && v.length <= max && !v.includes('\0') ? v : undefined;
}

/** A string with 0..max chars and no NUL. */
function strOrEmpty(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : undefined;
}

/** An id (agent, request, nonce): non-empty, bounded, no control characters. */
/** A look id for the case tab hand-off: a short lowercase token, else undefined (the field is then dropped). */
function lookId(v: unknown): string | undefined {
  return typeof v === 'string' && LOOK_ID_PATTERN.test(v) ? v : undefined;
}

function id(v: unknown): string | undefined {
  const s = str(v, LIMITS.idChars);
  // eslint-disable-next-line no-control-regex
  return s !== undefined && !/[\u0000-\u001f\u007f]/.test(s) ? s : undefined;
}

/** A Claude Code session id: letters, digits, dot, underscore, hyphen. */
function sessionId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v) ? v : undefined;
}

/** A non-blank text (prompt, reply) within the prompt limit. */
function text(v: unknown): string | undefined {
  const s = str(v, LIMITS.promptChars);
  return s !== undefined && s.trim().length > 0 ? s : undefined;
}

function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** An effort level, or undefined when it is not one of EFFORT_LEVELS. */
function effortLevel(v: unknown): EffortLevel | undefined {
  return isEffortLevel(v) ? v : undefined;
}

/** A model name or alias: at most LIMITS.modelChars, letters, digits and . _ : [ ] - only (e.g. 'opus', 'claude-haiku-5-5', 'opus[1m]'). */
function modelName(v: unknown): string | undefined {
  const s = str(v, LIMITS.modelChars);
  return s !== undefined && /^[A-Za-z0-9._:\[\]-]+$/.test(s) ? s : undefined;
}

/** A tool_use id (a plan id): letters, digits, dot, underscore, colon, hyphen, at most 128 characters. */
function toolUseId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : undefined;
}

/**
 * A path relative to a file room root, in POSIX form, for `listDir`, `readFile`, `openFile` and `openDiff`. Accepts `''`
 * (the root itself) and paths like `src/a b/é.ts` or `.github/workflows/ci.yml`. Rejects non-strings, more than
 * LIMITS.relPathChars, control characters (U+0000 to U+001F and U+007F), backslashes, a leading `/` (absolute and UNC),
 * a drive letter (`C:`, `c:/x`), a trailing `/`, empty segments (`a//b`), and any segment made only of dots and spaces
 * (`.`, `..`, `...`, which Windows may fold into `..`). This is the first line of defence only: the host still resolves
 * the path with `realpath` and checks `isInsideDir` before touching the disk. Returns the string unchanged (so `''` is a
 * valid result: callers compare against undefined).
 */
export function relPath(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > LIMITS.relPathChars) return undefined;
  if (v === '') return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v) || v.includes('\\') || v.startsWith('/') || v.endsWith('/') || /^[A-Za-z]:/.test(v)) return undefined;
  for (const seg of v.split('/')) if (seg === '' || /^[. ]+$/.test(seg)) return undefined;
  return v;
}

function catalogSection(v: unknown): CatalogSection | undefined {
  return typeof v === 'string' && (CATALOG_SECTIONS as readonly string[]).includes(v) ? (v as CatalogSection) : undefined;
}

const SESSION_OPTION_KEYS: readonly string[] = ['model', 'effort', 'permissionMode'];

/**
 * The `options` of setSessionOptions. Only model, effort and permissionMode are allowed (any other key, such as a
 * smuggled `bypassPermissions`, rejects the whole message) and at least one must be present. `null` for model or effort
 * means "reset to the default"; permissionMode has no null. `undefined` values count as absent.
 */
function parseSessionOptions(v: unknown): SessionOptions | undefined {
  if (!isObj(v)) return undefined;
  for (const k of Object.keys(v)) if (!SESSION_OPTION_KEYS.includes(k)) return undefined;
  const out: SessionOptions = {};
  if (v.model !== undefined) {
    if (v.model === null) out.model = null;
    else {
      const m = modelName(v.model);
      if (m === undefined) return undefined;
      out.model = m;
    }
  }
  if (v.effort !== undefined) {
    if (v.effort === null) out.effort = null;
    else {
      const e = effortLevel(v.effort);
      if (e === undefined) return undefined;
      out.effort = e;
    }
  }
  if (v.permissionMode !== undefined) {
    if (!isPermissionMode(v.permissionMode)) return undefined;
    out.permissionMode = v.permissionMode;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** One of the Front desk's allowlisted setting keys. `claudePath`, `themeFile` and anything else is undefined. */
function frontDeskKey(v: unknown): FrontDeskSettingKey | undefined {
  return typeof v === 'string' && (FRONT_DESK_SETTINGS as readonly string[]).includes(v) ? (v as FrontDeskSettingKey) : undefined;
}

/**
 * The value of a setSetting, checked against the key: text keys take trimmed text of at most LIMITS.settingChars with no
 * control characters (empty is allowed: an empty branch name gives a one-line sign), boolean keys take booleans, enum
 * keys take one of their values. `null` (reset to the default) is allowed for every key. Returns undefined when invalid
 * (null is a valid result, so callers compare against undefined).
 */
function settingValue(key: FrontDeskSettingKey, v: unknown): string | boolean | null | undefined {
  if (v === null) return null;
  if ((FRONT_DESK_TEXT_SETTINGS as readonly string[]).includes(key)) {
    // eslint-disable-next-line no-control-regex
    if (typeof v !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return undefined;
    const t = v.trim();
    return t.length <= LIMITS.settingChars ? t : undefined;
  }
  if ((FRONT_DESK_BOOLEAN_SETTINGS as readonly string[]).includes(key)) return typeof v === 'boolean' ? v : undefined;
  const allowed = (FRONT_DESK_ENUM_VALUES as Record<string, readonly string[] | undefined>)[key];
  return allowed !== undefined && typeof v === 'string' && allowed.includes(v) ? v : undefined;
}

/** A preset id: `^[a-z0-9-]{1,40}$`. */
function presetId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v) ? v : undefined;
}

/** A theme file name in the themes folder: `*.theme.json`, at most LIMITS.themeIdChars, no path parts, no `..`, no leading dot, no control characters. */
function themeId(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > LIMITS.themeIdChars || !v.endsWith('.theme.json')) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\]/.test(v) || v.includes('..') || v.startsWith('.')) return undefined;
  return v;
}

/** A theme revision: 16 lowercase hex characters (the first 16 of a sha256). */
function themeRev(v: unknown): string | undefined {
  return typeof v === 'string' && /^[0-9a-f]{16}$/.test(v) ? v : undefined;
}

/** A theme file's JSON text: a string of at most LIMITS.themeJsonChars. Not parsed here (the host re-parses it). Empty is allowed; the host's parse rejects it. */
function themeJson(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= LIMITS.themeJsonChars ? v : undefined;
}

function themeAction(v: unknown): ThemeActionKind | undefined {
  return typeof v === 'string' && (THEME_ACTIONS as readonly string[]).includes(v) ? (v as ThemeActionKind) : undefined;
}

function parseAssign(v: unknown): AssignTarget | undefined {
  if (!isObj(v)) return undefined;
  if (v.kind === 'new') return { kind: 'new' };
  if (v.kind === 'existing') {
    const sid = sessionId(v.sessionId);
    return sid === undefined ? undefined : { kind: 'existing', sessionId: sid };
  }
  return undefined;
}

/** A map key that cannot pollute prototypes. */
function safeKey(k: string): boolean {
  return k.length >= 1 && k.length <= LIMITS.questionChars && !k.includes('\0') && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

function parseDecision(v: unknown): DecisionPayload | undefined {
  if (!isObj(v)) return undefined;
  switch (v.kind) {
    case 'allow': {
      if (v.always !== undefined && typeof v.always !== 'boolean') return undefined;
      return v.always === undefined ? { kind: 'allow' } : { kind: 'allow', always: v.always };
    }
    case 'deny': {
      if (v.message === undefined) return { kind: 'deny' };
      const m = strOrEmpty(v.message, LIMITS.feedbackChars);
      return m === undefined ? undefined : { kind: 'deny', message: m };
    }
    case 'plan': {
      if (typeof v.approve !== 'boolean') return undefined;
      if (v.feedback === undefined) return { kind: 'plan', approve: v.approve };
      const f = strOrEmpty(v.feedback, LIMITS.feedbackChars);
      return f === undefined ? undefined : { kind: 'plan', approve: v.approve, feedback: f };
    }
    case 'answer': {
      if (!isObj(v.answers)) return undefined;
      const keys = Object.keys(v.answers);
      if (keys.length === 0 || keys.length > LIMITS.questions) return undefined;
      const answers: Record<string, string | string[]> = {};
      for (const k of keys) {
        if (!safeKey(k)) return undefined;
        const a = v.answers[k];
        if (typeof a === 'string') {
          if (a.length > LIMITS.labelChars || a.includes('\0')) return undefined;
          answers[k] = a;
        } else if (Array.isArray(a)) {
          if (a.length > LIMITS.multiAnswers) return undefined;
          const out: string[] = [];
          for (const x of a) {
            if (typeof x !== 'string' || x.length > LIMITS.labelChars || x.includes('\0')) return undefined;
            out.push(x);
          }
          answers[k] = out;
        } else return undefined;
      }
      if (v.other === undefined) return { kind: 'answer', answers };
      if (!isObj(v.other)) return undefined;
      const okeys = Object.keys(v.other);
      if (okeys.length > LIMITS.questions) return undefined;
      const other: Record<string, string> = {};
      for (const k of okeys) {
        const o = strOrEmpty(v.other[k], LIMITS.feedbackChars);
        if (!safeKey(k) || o === undefined) return undefined;
        other[k] = o;
      }
      return { kind: 'answer', answers, other };
    }
    default:
      return undefined;
  }
}

/** Validate an untrusted message from the webview. Returns undefined for anything malformed. Never throws. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  try {
    if (!isObj(raw) || typeof raw.type !== 'string') return undefined;
    switch (raw.type) {
      case 'ready':
      case 'closeCase':
      case 'listProjects':
      case 'browseProject':
      case 'refreshUsage':
        return { type: raw.type };
      case 'openCase': {
        const agentId = id(raw.agentId);
        return agentId === undefined ? undefined : { type: 'openCase', agentId };
      }
      case 'newTask': {
        const nonce = id(raw.nonce);
        const projectPath = str(raw.projectPath, LIMITS.pathChars);
        const prompt = text(raw.prompt);
        const assignTo = parseAssign(raw.assignTo);
        if (nonce === undefined || projectPath === undefined || prompt === undefined || assignTo === undefined) return undefined;
        if (!isPermissionMode(raw.permissionMode)) return undefined;
        const msg: WebviewToHost = { type: 'newTask', nonce, projectPath, prompt, assignTo, permissionMode: raw.permissionMode };
        if (raw.model !== undefined) {
          const model = modelName(raw.model);
          if (model === undefined) return undefined;
          msg.model = model;
        }
        if (raw.effort !== undefined) {
          const effort = effortLevel(raw.effort);
          if (effort === undefined) return undefined;
          msg.effort = effort;
        }
        return msg;
      }
      case 'reply': {
        const sid = sessionId(raw.sessionId);
        const t = text(raw.text);
        return sid === undefined || t === undefined ? undefined : { type: 'reply', sessionId: sid, text: t };
      }
      case 'decide': {
        const requestId = id(raw.requestId);
        const decision = parseDecision(raw.decision);
        return requestId === undefined || decision === undefined ? undefined : { type: 'decide', requestId, decision };
      }
      case 'interrupt':
      case 'openInClaudeCode': {
        const sid = sessionId(raw.sessionId);
        return sid === undefined ? undefined : { type: raw.type, sessionId: sid };
      }
      case 'setSessionOptions': {
        const nonce = id(raw.nonce);
        const sid = sessionId(raw.sessionId);
        const options = parseSessionOptions(raw.options);
        return nonce === undefined || sid === undefined || options === undefined ? undefined : { type: 'setSessionOptions', nonce, sessionId: sid, options };
      }
      case 'getPlan': {
        const reqId = id(raw.reqId);
        const agentId = id(raw.agentId);
        const planId = toolUseId(raw.planId);
        return reqId === undefined || agentId === undefined || planId === undefined ? undefined : { type: 'getPlan', reqId, agentId, planId };
      }
      case 'getTurn': {
        const reqId = id(raw.reqId);
        const agentId = id(raw.agentId);
        return reqId === undefined || agentId === undefined ? undefined : { type: 'getTurn', reqId, agentId };
      }
      case 'getFrontDesk': {
        const reqId = id(raw.reqId);
        return reqId === undefined ? undefined : { type: 'getFrontDesk', reqId };
      }
      case 'themeAction': {
        const reqId = id(raw.reqId);
        const action = themeAction(raw.action);
        if (reqId === undefined || action === undefined) return undefined;
        if (action === 'useUserTheme') {
          const tid = themeId(raw.themeId);
          return tid === undefined || raw.presetId !== undefined ? undefined : { type: 'themeAction', reqId, action, themeId: tid };
        }
        if (raw.themeId !== undefined) return undefined;
        const needsPreset = action === 'usePreset' || action === 'copyPreset';
        if (!needsPreset) return raw.presetId === undefined ? { type: 'themeAction', reqId, action } : undefined;
        const pid = presetId(raw.presetId);
        return pid === undefined ? undefined : { type: 'themeAction', reqId, action, presetId: pid };
      }
      case 'setSetting': {
        const reqId = id(raw.reqId);
        const key = frontDeskKey(raw.key);
        if (reqId === undefined || key === undefined) return undefined;
        const value = settingValue(key, raw.value);
        return value === undefined ? undefined : { type: 'setSetting', reqId, key, value };
      }
      case 'saveTheme': {
        const reqId = id(raw.reqId);
        const rev = themeRev(raw.rev);
        const json = themeJson(raw.themeJson);
        if (reqId === undefined || rev === undefined || json === undefined) return undefined;
        if (raw.force === undefined) return { type: 'saveTheme', reqId, rev, themeJson: json };
        return raw.force === true ? { type: 'saveTheme', reqId, rev, themeJson: json, force: true } : undefined;
      }
      case 'saveThemeAs': {
        const reqId = id(raw.reqId);
        const json = themeJson(raw.themeJson);
        return reqId === undefined || json === undefined ? undefined : { type: 'saveThemeAs', reqId, themeJson: json };
      }
      case 'openSettingsUi': {
        const key = raw.key === 'themeFile' ? 'themeFile' : frontDeskKey(raw.key);
        if (key === undefined || (raw.target !== 'user' && raw.target !== 'workspace')) return undefined;
        return { type: 'openSettingsUi', key, target: raw.target };
      }
      case 'getFileRoots': {
        const reqId = id(raw.reqId);
        return reqId === undefined ? undefined : { type: 'getFileRoots', reqId };
      }
      case 'listDir':
      case 'readFile': {
        const reqId = id(raw.reqId);
        const rootId = id(raw.rootId);
        const rel = relPath(raw.relPath);
        return reqId === undefined || rootId === undefined || rel === undefined ? undefined : { type: raw.type, reqId, rootId, relPath: rel };
      }
      case 'openFile':
      case 'openDiff': {
        const rootId = id(raw.rootId);
        const rel = relPath(raw.relPath);
        return rootId === undefined || rel === undefined ? undefined : { type: raw.type, rootId, relPath: rel };
      }
      case 'getCatalog': {
        const reqId = id(raw.reqId);
        const section = catalogSection(raw.section);
        if (reqId === undefined || section === undefined) return undefined;
        // `refresh` is true or absent; any other value rejects the message (like `saveTheme.force`).
        if (raw.refresh !== undefined && raw.refresh !== true) return undefined;
        const msg: Extract<WebviewToHost, { type: 'getCatalog' }> = { type: 'getCatalog', reqId, section };
        if (raw.rootId !== undefined) {
          const rootId = id(raw.rootId);
          if (rootId === undefined) return undefined;
          msg.rootId = rootId;
        }
        if (raw.refresh === true) msg.refresh = true;
        return msg;
      }
      case 'openConfigFile': {
        const fileId = id(raw.fileId);
        return fileId === undefined ? undefined : { type: 'openConfigFile', fileId };
      }
      case 'openCaseTab': {
        const agentId = id(raw.agentId);
        if (agentId === undefined) return undefined;
        const look = lookId(raw.look);
        return look === undefined ? { type: 'openCaseTab', agentId } : { type: 'openCaseTab', agentId, look };
      }
      case 'updateAction': {
        const action = raw.action;
        return typeof action === 'string' && (UPDATE_ACTIONS as readonly string[]).includes(action) ? { type: 'updateAction', action: action as UpdateAction } : undefined;
      }
      case 'sendHome': {
        const agentId = id(raw.agentId);
        return agentId === undefined ? undefined : { type: 'sendHome', agentId };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Validate the boot data of a case tab (the parsed JSON of the `mm-boot` element). Returns a fresh `{mode:'case', agentId}`
 * (extra keys dropped) or undefined for anything else. Never throws.
 */
export function parseCaseTabBoot(raw: unknown): CaseTabBoot | undefined {
  try {
    if (!isObj(raw) || raw.mode !== 'case') return undefined;
    const agentId = id(raw.agentId);
    if (agentId === undefined) return undefined;
    const look = lookId(raw.look);
    return look === undefined ? { mode: 'case', agentId } : { mode: 'case', agentId, look };
  } catch {
    return undefined;
  }
}
