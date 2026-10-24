import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDefaultsService, SETTINGS_POLL_MS, combineClaudeDefaults } from '../src/host/claudeDefaults.ts';
import type { ClaudeDefaults, HostToWebview, ModelChoice } from '../src/shared/protocol.ts';

const MODELS: ModelChoice[] = [
  { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5', efforts: ['low', 'high', 'xhigh'] },
  { value: 'sonnet', label: 'Sonnet' },
];

function harness(opts: { env?: Record<string, string | undefined> } = {}) {
  const posts: ClaudeDefaults[] = [];
  const logs: string[] = [];
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const state = { text: '{}' as string, mtime: 1, missing: false, reads: 0 };
  const svc = new ClaudeDefaultsService({
    post: (m: Extract<HostToWebview, { type: 'claudeDefaults' }>) => posts.push(m.defaults),
    fs: {
      stat: async () => {
        if (state.missing) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return { mtimeMs: state.mtime, size: state.text.length };
      },
      readFile: async () => {
        state.reads++;
        return state.text;
      },
    },
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.push({ id, fn, ms });
        return id;
      },
      clearTimeout: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    settingsPath: '/home/u/.claude/settings.json',
    env: () => opts.env ?? {},
    log: (m) => logs.push(m),
  });
  const tick = async (): Promise<void> => {
    const t = timers.shift();
    assert.ok(t, 'a timer is pending');
    t.fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  };
  return { svc, posts, logs, timers, state, tick };
}

test('combineClaudeDefaults: settings, env over settings, models only when known', () => {
  const settings = { model: 'opus', effortLevel: 'high', modelSettings: { opus: { effortLevel: 'xhigh' } } };
  assert.deepEqual(combineClaudeDefaults(settings, {}, undefined), { model: 'opus', effort: 'high', effortByModel: { opus: 'xhigh' } });
  assert.deepEqual(combineClaudeDefaults(settings, { ANTHROPIC_MODEL: 'sonnet', CLAUDE_CODE_EFFORT_LEVEL: 'low' }, []), { model: 'sonnet', effort: 'low', effortByModel: { opus: 'xhigh' } });
  const withModels = combineClaudeDefaults(undefined, {}, MODELS);
  assert.deepEqual(withModels, { effortByModel: {}, models: MODELS });
  assert.notEqual(withModels.models![0], MODELS[0], 'models are copied');
});

test('combineClaudeDefaults: other env variables and unknown settings keys never reach the result', () => {
  const out = combineClaudeDefaults({ model: 'opus', apiKeyHelper: 'SECRET-HELPER', env: { ANTHROPIC_API_KEY: 'SECRET-KEY' } }, { ANTHROPIC_API_KEY: 'SECRET-KEY', HOME: '/home/u' }, undefined);
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
  assert.equal(JSON.stringify(out).includes('/home/u'), false);
});

test('polls only while visible; first poll posts, an unchanged file posts nothing, a change posts again', async () => {
  const h = harness();
  assert.equal(h.timers.length, 0);
  h.state.text = JSON.stringify({ model: 'opus', effortLevel: 'high' });
  h.svc.setVisible(true);
  await h.tick();
  assert.deepEqual(h.posts, [{ model: 'opus', effort: 'high', effortByModel: {} }]);
  assert.equal(h.timers[0]?.ms, SETTINGS_POLL_MS);
  assert.equal(SETTINGS_POLL_MS, 5000);
  await h.tick(); // same mtime: no read, no post
  assert.equal(h.posts.length, 1);
  h.state.mtime = 2;
  h.state.text = JSON.stringify({ model: 'sonnet', effortLevel: 'high' });
  await h.tick();
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1]!.model, 'sonnet');
  // The file is rewritten with the same meaning: the file is re-read, but nothing is posted.
  h.state.mtime = 3;
  h.state.text = JSON.stringify({ effortLevel: 'high', model: 'sonnet', unrelated: [1, 2, 3] });
  await h.tick();
  assert.equal(h.posts.length, 2);
  h.svc.setVisible(false);
  assert.equal(h.timers.length, 0);
  h.svc.setVisible(false);
  assert.equal(h.timers.length, 0);
});

test('a missing settings file still posts the env-only defaults once', async () => {
  const h = harness({ env: { ANTHROPIC_MODEL: 'haiku' } });
  h.state.missing = true;
  h.svc.setVisible(true);
  await h.tick();
  assert.deepEqual(h.posts, [{ model: 'haiku', effortByModel: {} }]);
  await h.tick();
  assert.equal(h.posts.length, 1);
});

test('a broken settings file keeps the last good values and logs only a reason', async () => {
  const h = harness();
  h.state.text = JSON.stringify({ model: 'opus' });
  h.svc.setVisible(true);
  await h.tick();
  h.state.mtime = 2;
  h.state.text = '{ "model": "opus", SECRET-GARBAGE';
  await h.tick();
  assert.equal(h.posts.length, 1);
  assert.equal(h.svc.current().model, 'opus');
  assert.ok(h.logs.some((l) => /unreadable \(invalid\)/.test(l)));
  assert.equal(h.logs.join('\n').includes('SECRET'), false);
  // Deleting the file clears the file's values.
  h.state.missing = true;
  await h.tick();
  assert.deepEqual(h.posts.at(-1), { effortByModel: {} });
});

test('setModels adds the probe list to the defaults, reposts, ignores an empty list and repeats', async () => {
  const h = harness();
  h.state.text = JSON.stringify({ model: 'opus' });
  h.svc.setVisible(true);
  await h.tick();
  assert.equal(h.posts[0]!.models, undefined);
  h.svc.setModels(MODELS);
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.posts[1], { model: 'opus', effortByModel: {}, models: MODELS });
  h.svc.setModels(MODELS.map((m) => ({ ...m })));
  assert.equal(h.posts.length, 2, 'an identical list posts nothing');
  h.svc.setModels([]);
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.svc.current().models, MODELS);
  // A later settings change keeps the models.
  h.state.mtime = 2;
  h.state.text = JSON.stringify({ model: 'sonnet' });
  await h.tick();
  assert.deepEqual(h.posts.at(-1), { model: 'sonnet', effortByModel: {}, models: MODELS });
});

test('dispose stops polling', async () => {
  const h = harness();
  h.svc.setVisible(true);
  h.svc.dispose();
  assert.equal(h.timers.length, 0);
});
