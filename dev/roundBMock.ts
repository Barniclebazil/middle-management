// The Round B half of the harness's mock host (dev/harness.ts): answers the seven file room and catalog requests the way the real
// host's officeRequests would, so the real panels in the real webview can be driven in a browser. It reuses the data and the
// answer logic of the panel playground (dev/panelsFiles.ts and dev/panelsDesk.ts), so their URL params work here too:
//   ?fr=...&frlag=...   the file room (error | empty | one | hang-roots | hang-dirs | hang-files | push)
//   ?lib=...&liblag=... the training library (empty | few | big | error | hang | slowfail | later)
//   ?desk=...&delay=... the phone, handbook and agency (error | loading | slow | empty | small | big | settled)
// plus the harness's own:
//   ?phone=ok|mixed|bad|many|connecting|none   the phone lights the office starts with (as if a panel had been opened already)
//   ?shelf=<n>                                 the bookshelf's book count the office starts with (skills plus commands)
//   ?openfail=1                                openFile, openDiff and openConfigFile answer with a toast-style error
// Nothing here is used in production.
import type { HostToWebview, McpServerItem, McpStatus, SkillItem, WebviewToHost } from '../src/shared/protocol.ts';
import { answerCatalog } from './panelsDesk.ts';
import { fileRoomAnswer, libraryAnswer } from './panelsFiles.ts';

/** The message types this mock answers (the seven Round B requests). */
const TYPES = new Set<string>(['getFileRoots', 'listDir', 'readFile', 'openFile', 'openDiff', 'getCatalog', 'openConfigFile']);

export interface RoundBMock {
  handles(msg: WebviewToHost): boolean;
  /** Answers one request (replies are sent after the usual delay). */
  handle(msg: WebviewToHost): void;
  /** The catalog replies that preset the phone and the shelf (`?phone=` and `?shelf=`), to send once the page is up. */
  preset(): HostToWebview[];
}

const LIGHT_SETS: Record<string, McpStatus[]> = {
  ok: ['connected', 'connected', 'connected'],
  mixed: ['connected', 'failed', 'needsAuth', 'connected', 'disabled'],
  bad: ['failed', 'failed', 'needsAuth'],
  many: ['connected', 'connected', 'connected', 'connected', 'connected', 'needsAuth', 'connected'],
  connecting: ['pending', 'pending', 'connected'],
};

const server = (status: McpStatus, i: number): McpServerItem => ({ name: `preset-line-${i + 1}`, scope: 'user', transport: 'stdio', status });

export function createRoundBMock(params: URLSearchParams, send: (msg: HostToWebview) => void): RoundBMock {
  const files = fileRoomAnswer(params);
  const library = libraryAnswer(params);
  const openFail = params.get('openfail') === '1';
  const reply = (msg: HostToWebview, afterMs = 0): void => { setTimeout(() => { send(msg); }, afterMs); };
  return {
    handles: (msg) => TYPES.has(msg.type),
    handle(msg) {
      switch (msg.type) {
        case 'getFileRoots':
        case 'listDir':
        case 'readFile':
          files(msg, send);
          return;
        case 'getCatalog':
          if (msg.section === 'skills') library(msg, send);
          else answerCatalog(msg, params, reply);
          return;
        case 'openFile':
        case 'openDiff':
        case 'openConfigFile':
          console.log('[harness]', msg.type, JSON.stringify(msg));
          // A failure to open arrives as an error with no ids: the webview shows it as a toast.
          if (openFail) reply({ type: 'error', message: 'That file could not be opened. It may have been moved or deleted.' }, 200);
          return;
        default:
          return;
      }
    },
    preset() {
      const out: HostToWebview[] = [];
      const lights = LIGHT_SETS[params.get('phone') ?? ''];
      if (lights) out.push({ type: 'catalog', reqId: 'harness-preset-mcp', section: 'mcp', servers: lights.map(server), truncated: false });
      const shelf = Number(params.get('shelf'));
      if (params.get('shelf') !== null && params.get('shelf') !== '' && Number.isFinite(shelf) && shelf >= 0) {
        const n = Math.floor(shelf);
        const skills: SkillItem[] = Array.from({ length: n }, (_, i) => ({ name: `preset-skill-${i + 1}`, invoke: `preset-skill-${i + 1}`, description: '', source: 'user' }));
        out.push({ type: 'catalog', reqId: 'harness-preset-skills', section: 'skills', skills, commands: [], truncated: false });
      }
      return out;
    },
  };
}
