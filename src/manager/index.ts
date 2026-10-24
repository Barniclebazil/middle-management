// Public surface of the manager layer (task 7.1). 8.1 wires `createManagerHost` into the extension.
// No `vscode` import.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { UnsupportedControlError } from './sessionRunner.ts';
import type { ControlMethod, QueryFn, SdkQuery } from './sessionRunner.ts';

export * from './claudeBinary.ts';
export * from './projects.ts';
export * from './control.ts';
export * from './cost.ts';
export * from './pending.ts';
export * from './sessionRunner.ts';
export * from './managerHost.ts';

/**
 * The real SDK `query`, imported on first use so that loading the extension does not load the 1.3 MB SDK.
 * `query()` is synchronous but the import is not, so this returns a thin query that waits for it. A failed import
 * shows up as an error thrown while iterating, which the runner reports as a notice.
 */
export const defaultQueryFn: QueryFn = (params) => {
  const ready: Promise<SdkQuery> = import('@anthropic-ai/claude-agent-sdk').then((m) => m.query(params));
  ready.catch(() => undefined); // surfaced through iteration; avoid an unhandled rejection if never iterated
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
      const q = await ready;
      for await (const msg of q as AsyncIterable<SDKMessage>) yield msg;
    },
    async interrupt(): Promise<unknown> {
      return (await ready).interrupt();
    },
    close(): void {
      void ready.then((q) => q.close?.()).catch(() => undefined);
    },
    // Control methods are always present on the wrapper (it cannot know the real query's shape yet); each checks the
    // real one once it is ready and throws UnsupportedControlError when an older build lacks the method.
    setModel: (model) => control(ready, 'setModel', model),
    setPermissionMode: (mode) => control(ready, 'setPermissionMode', mode),
    applyFlagSettings: (settings) => control(ready, 'applyFlagSettings', settings),
    initializationResult: () => control(ready, 'initializationResult'),
    getContextUsage: (opts) => control(ready, 'getContextUsage', opts),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts) => control(ready, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', opts),
    supportedCommands: () => control(ready, 'supportedCommands'),
    supportedAgents: () => control(ready, 'supportedAgents'),
    mcpServerStatus: () => control(ready, 'mcpServerStatus'),
  };
};

/** Call `name` on the real query with `this` bound, or throw UnsupportedControlError when it has no such method. */
async function control(ready: Promise<SdkQuery>, name: ControlMethod, arg?: unknown): Promise<unknown> {
  const q = await ready;
  const fn = q[name] as ((a?: unknown) => Promise<unknown>) | undefined;
  if (typeof fn !== 'function') throw new UnsupportedControlError(name);
  return fn.call(q, arg);
}
