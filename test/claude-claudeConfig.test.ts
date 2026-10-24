import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CLAUDE_JSON_BYTES,
  parseClaudeDefaults,
  parseInitInfo,
  parseJsonText,
  parseProbeExtra,
  parseProbePlan,
  parseProbeUsage,
  parseRateLimitInfo,
  parseSkillUsage,
  MAX_SKILL_USAGE_ENTRIES,
  parseUsageCache,
  readCappedJson,
} from '../src/claude/claudeConfig.ts';
import { LIMITS } from '../src/shared/protocol.ts';

const NOW = 1_800_000_000_000;

const fakeClaudeJson = {
  userID: 'SENTINEL_USERID',
  oauthAccount: { emailAddress: 'SENTINEL_EMAIL_x@example.invalid', organizationName: 'SENTINEL_ORG', accessToken: 'SENTINEL_TOKEN' },
  mcpServers: { s: { url: 'SENTINEL_URL', env: { KEY: 'SENTINEL_ENV' } } },
  projects: { '/p': { mcpServers: { a: { command: 'SENTINEL_CMD' } } } },
  cachedUsageUtilization: {
    fetchedAtMs: 1_799_999_000_000,
    accountUuid: 'SENTINEL_UUID',
    utilization: {
      five_hour: { utilization: 46, resets_at: '2027-01-15T10:00:00.000000+00:00', limit_dollars: null },
      seven_day: { utilization: 18, resets_at: '2027-01-20T10:00:00+00:00' },
      seven_day_opus: null,
      secret_codename: { utilization: 3, resets_at: 'SENTINEL_CODENAME' },
      extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 150, utilization: null, currency: 'SENTINEL_CUR', decimal_places: 2 },
      limits: [{ kind: 'SENTINEL_LIMITS' }],
    },
  },
};

const fakeInit = {
  account: { email: 'SENTINEL_EMAIL_x@example.invalid', organization: 'SENTINEL_ORG', subscriptionType: 'Claude Max', tokenSource: 'SENTINEL_TOKEN' },
  models: [
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'SENTINEL_DESC', supportedEffortLevels: ['low', 'max', 'bogus', 'high'] },
    { value: 'old', displayName: 'Old' },
    { displayName: 'no value' },
    'junk',
  ],
  commands: [{ name: 'SENTINEL_CMD' }],
  pid: 1,
};

const fakeProbe = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 45, resets_at: '2027-01-15T10:00:00+00:00' },
    seven_day: { utilization: 18, resets_at: '2027-01-20T10:00:00+00:00' },
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0, decimal_places: 2, currency: 'SENTINEL_CUR' },
    spend: { disclaimer: 'SENTINEL_SPEND' },
  },
  session: { x: 'SENTINEL_SESSION' },
};

const fakeEvent = {
  status: 'allowed_warning',
  rateLimitType: 'five_hour',
  resetsAt: 1_800_001_000,
  unifiedWindows: { five_hour: { utilization: 0.45, resetsAt: 1_800_001_000 }, seven_day: { utilization: 0.18, resetsAt: 1_800_500_000 }, junk: { utilization: 1 } },
  other: 'SENTINEL_OTHER',
};

const fakeSettings = {
  model: 'opus',
  effortLevel: 'high',
  modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh', note: 'SENTINEL_NOTE' }, bad: { effortLevel: 'nope' } },
  env: { ANTHROPIC_API_KEY: 'SENTINEL_APIKEY' },
  apiKeyHelper: 'SENTINEL_HELPER',
};

const fakeEnv = {
  ANTHROPIC_API_KEY: 'SENTINEL_ENVKEY',
  ANTHROPIC_AUTH_TOKEN: 'SENTINEL_AUTH',
  HOME: 'SENTINEL_HOME',
  ANTHROPIC_MODEL: 'sonnet',
  CLAUDE_CODE_EFFORT_LEVEL: 'Low',
};

test('sentinel: no parser output contains planted secrets', () => {
  const outs = [
    parseUsageCache(fakeClaudeJson, NOW),
    parseProbeUsage(fakeProbe, NOW),
    parseProbeExtra(fakeProbe),
    parseProbePlan(fakeProbe),
    parseRateLimitInfo(fakeEvent, NOW),
    parseInitInfo(fakeInit),
    parseClaudeDefaults(fakeSettings, fakeEnv),
    parseClaudeDefaults(fakeClaudeJson, fakeEnv),
    parseInitInfo(fakeClaudeJson),
    parseUsageCache(fakeInit, NOW),
  ];
  for (const o of outs) assert.ok(!JSON.stringify(o ?? null).includes('SENTINEL'), JSON.stringify(o));
  // sanity: the parsers did produce data
  assert.equal(parseUsageCache(fakeClaudeJson, NOW).windows.length, 2);
  assert.equal(parseInitInfo(fakeInit).models.length, 2);
});

test('parseUsageCache: 0..100 percent, ISO to ms, extra in major units, fetch time as asOf', () => {
  const r = parseUsageCache(fakeClaudeJson, NOW);
  assert.deepEqual(r.windows, [
    { id: 'five_hour', pct: 46, resetsAt: Date.parse('2027-01-15T10:00:00Z'), asOf: 1_799_999_000_000 },
    { id: 'seven_day', pct: 18, resetsAt: Date.parse('2027-01-20T10:00:00Z'), asOf: 1_799_999_000_000 },
  ]);
  assert.equal(r.fetchedAt, 1_799_999_000_000);
  assert.deepEqual(r.extra, { enabled: true, usedUsd: 1.5, limitUsd: 20, pct: null });
});

test('extra usage: currency is kept only as a 3-letter ISO code (upper-cased), anything else is dropped', () => {
  const mk = (currency: unknown) => ({
    cachedUsageUtilization: { utilization: { extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 150, decimal_places: 2, currency } } },
  });
  assert.equal(parseUsageCache(mk('gbp'), NOW).extra?.currency, 'GBP');
  assert.equal(parseUsageCache(mk('USD'), NOW).extra?.currency, 'USD');
  for (const bad of ['SENTINEL_CUR', 'GB', '', 7, null, undefined]) assert.equal(parseUsageCache(mk(bad), NOW).extra?.currency, undefined);
  const probe = { rate_limits: { extra_usage: { is_enabled: true, currency: 'eur', decimal_places: 2, used_credits: 100 } } };
  assert.deepEqual(parseProbeExtra(probe), { enabled: true, usedUsd: 1, currency: 'EUR' });
});

test('parseUsageCache: bad inputs give empty results', () => {
  for (const bad of [undefined, null, 5, 'x', [], {}, { cachedUsageUtilization: 3 }, { cachedUsageUtilization: { utilization: [] } }]) {
    assert.deepEqual(parseUsageCache(bad, NOW), { windows: [] });
  }
  const r = parseUsageCache({ cachedUsageUtilization: { utilization: { five_hour: { utilization: 'x', resets_at: 'nope' } } } }, NOW);
  assert.deepEqual(r.windows, [{ id: 'five_hour', pct: null, asOf: NOW }]);
});

test('parseUsageCache: clamps percent, ignores a prototype-polluting key', () => {
  const r = parseUsageCache({ cachedUsageUtilization: { utilization: { five_hour: { utilization: 250 }, seven_day: { utilization: -4 } } } }, NOW);
  assert.deepEqual(r.windows.map((w) => w.pct), [100, 0]);
});

test('parseProbeUsage: 0..100 and ISO to ms', () => {
  assert.deepEqual(parseProbeUsage(fakeProbe, NOW), [
    { id: 'five_hour', pct: 45, resetsAt: Date.parse('2027-01-15T10:00:00Z'), asOf: NOW },
    { id: 'seven_day', pct: 18, resetsAt: Date.parse('2027-01-20T10:00:00Z'), asOf: NOW },
  ]);
  assert.deepEqual(parseProbeExtra(fakeProbe), { enabled: false, usedUsd: 0, limitUsd: 50 });
  assert.equal(parseProbePlan(fakeProbe), 'Max');
  assert.deepEqual(parseProbeUsage({ rate_limits_available: false, rate_limits: fakeProbe.rate_limits }, NOW), []);
  for (const bad of [null, 1, 'x', [], {}, { rate_limits: 'x' }]) {
    assert.deepEqual(parseProbeUsage(bad, NOW), []);
    assert.equal(parseProbeExtra(bad), undefined);
    assert.equal(parseProbePlan(bad), undefined);
  }
});

test('parseRateLimitInfo: 0..1 to percent, seconds to ms, state on the binding window', () => {
  assert.deepEqual(parseRateLimitInfo(fakeEvent, NOW), [
    { id: 'five_hour', pct: 45, resetsAt: 1_800_001_000_000, asOf: NOW, state: 'warning' },
    { id: 'seven_day', pct: 18, resetsAt: 1_800_500_000_000, asOf: NOW },
  ]);
  const blocked = parseRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 1 } } }, NOW);
  assert.deepEqual(blocked, [{ id: 'seven_day', pct: 100, asOf: NOW, state: 'blocked' }]);
  const frac = parseRateLimitInfo({ unifiedWindows: { five_hour: { utilization: 0.07 } } }, NOW);
  assert.equal(frac[0]?.pct, 7);
  for (const bad of [null, 1, 'x', [], {}, { unifiedWindows: 4 }]) assert.deepEqual(parseRateLimitInfo(bad, NOW), []);
});

test('parseInitInfo: models, efforts limited to the contract, plan only', () => {
  const r = parseInitInfo(fakeInit);
  assert.deepEqual(r, {
    models: [
      { value: 'opus', label: 'Opus 5.5', resolved: 'claude-opus-5-5', efforts: ['low', 'high', 'max'] },
      { value: 'old', label: 'Old' },
    ],
    subscriptionType: 'Max',
  });
  for (const bad of [null, 1, 'x', [], {}, { models: 'x' }]) assert.deepEqual(parseInitInfo(bad).models, []);
});

test('parseInitInfo: caps the model list', () => {
  const models = Array.from({ length: 500 }, (_, i) => ({ value: `m${i}`, displayName: `M${i}` }));
  assert.equal(parseInitInfo({ models }).models.length, LIMITS.models);
});

test('parseClaudeDefaults: settings, env wins, only two env vars read', () => {
  assert.deepEqual(parseClaudeDefaults(fakeSettings, {}), { model: 'opus', effort: 'high', effortByModel: { 'claude-opus-5-5': 'xhigh' } });
  assert.deepEqual(parseClaudeDefaults(fakeSettings, fakeEnv), { model: 'sonnet', effort: 'low', effortByModel: { 'claude-opus-5-5': 'xhigh' } });
  assert.deepEqual(parseClaudeDefaults(null, { CLAUDE_CODE_EFFORT_LEVEL: 'bogus' }), { effortByModel: {} });
  for (const bad of [undefined, 3, 'x', [], { modelSettings: 'x' }, { modelSettings: [] }]) assert.deepEqual(parseClaudeDefaults(bad, {}), { effortByModel: {} });
  const proto = JSON.parse('{"modelSettings":{"__proto__":{"effortLevel":"low"}}}');
  const p = parseClaudeDefaults(proto, {});
  assert.deepEqual(Object.keys(p.effortByModel), []);
  assert.equal(({} as Record<string, unknown>)['effortLevel'], undefined);
});

test('readCappedJson: parses, refuses over 32 MB unread, handles missing and invalid', async () => {
  assert.equal(MAX_CLAUDE_JSON_BYTES, 32 * 1024 * 1024);
  let reads = 0;
  const mk = (size: number, text: string, err?: string) => ({
    stat: async () => {
      if (err) throw Object.assign(new Error('x'), { code: err });
      return { size };
    },
    readFile: async () => {
      reads++;
      return text;
    },
  });
  assert.deepEqual(await readCappedJson('/p', mk(5, '{"a":1}')), { ok: true, value: { a: 1 } });
  assert.deepEqual(await readCappedJson('/p', mk(5, '﻿{"a":1}')), { ok: true, value: { a: 1 } });
  reads = 0;
  assert.deepEqual(await readCappedJson('/p', mk(MAX_CLAUDE_JSON_BYTES + 1, '{}')), { ok: false, reason: 'tooLarge' });
  assert.equal(reads, 0);
  assert.deepEqual(await readCappedJson('/p', mk(MAX_CLAUDE_JSON_BYTES, '{}')), { ok: true, value: {} });
  assert.deepEqual(await readCappedJson('/p', mk(0, '', 'ENOENT')), { ok: false, reason: 'missing' });
  assert.deepEqual(await readCappedJson('/p', mk(0, '', 'EACCES')), { ok: false, reason: 'error' });
  assert.deepEqual(await readCappedJson('/p', mk(3, '{oops')), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseJsonText('{"a":2}'), { ok: true, value: { a: 2 } });
  assert.deepEqual(parseJsonText('{"a":2}', 3), { ok: false, reason: 'tooLarge' });
});

test('parseSkillUsage: counts and last-used times only, joined by name, tolerant of junk', () => {
  const raw = {
    skillUsage: {
      alpha: { usageCount: 7, lastUsedAt: 1_799_000_000_000, extra: 'SENTINEL_EXTRA' },
      'plug:beta': { usageCount: 2.9 },
      zero: { usageCount: 0, lastUsedAt: 0 },
      badCount: { usageCount: 'many', lastUsedAt: 5 },
      negative: { usageCount: -1 },
      noCount: { lastUsedAt: 5 },
      badTime: { usageCount: 3, lastUsedAt: 'yesterday' },
      notObject: 5,
      nested: ['x'],
      'ctl\u0000name': { usageCount: 1 },
    },
  };
  const m = parseSkillUsage(raw);
  assert.deepEqual(m.get('alpha'), { uses: 7, lastUsedAt: 1_799_000_000_000 });
  assert.deepEqual(m.get('plug:beta'), { uses: 2 });
  assert.deepEqual(m.get('zero'), { uses: 0 });
  assert.deepEqual(m.get('badTime'), { uses: 3 });
  assert.deepEqual(m.get('ctl name'), { uses: 1 });
  for (const k of ['badCount', 'negative', 'noCount', 'notObject', 'nested']) assert.equal(m.has(k), false, k);
  assert.equal(JSON.stringify([...m]).includes('SENTINEL_EXTRA'), false);
  for (const bad of [undefined, null, 3, 'x', [], {}, { skillUsage: 'x' }, { skillUsage: [] }, { skillUsage: null }]) assert.equal(parseSkillUsage(bad).size, 0);
});

test('parseSkillUsage: sentinel secrets elsewhere in .claude.json never reach the output', () => {
  const m = parseSkillUsage({ ...fakeClaudeJson, skillUsage: { alpha: { usageCount: 1, lastUsedAt: 2 } }, pluginUsage: { 'x@y': { usageCount: 9, secret: 'SENTINEL_PLUGIN' } }, agentLastUsed: { bg: 1 } });
  assert.deepEqual([...m], [['alpha', { uses: 1, lastUsedAt: 2 }]]);
  assert.equal(JSON.stringify([...m]).includes('SENTINEL'), false);
  // The whole fixture (account, MCP bodies) with no skillUsage key gives nothing at all.
  assert.equal(parseSkillUsage(fakeClaudeJson).size, 0);
  // A secret planted AS a skill name is just a name (the caller shows names), but never a value from another key.
  const m2 = parseSkillUsage({ oauthAccount: { skillUsage: { SENTINEL_NESTED: { usageCount: 1 } } }, skillUsage: { ok: { usageCount: 1 } } });
  assert.deepEqual([...m2.keys()], ['ok']);
});

test('parseSkillUsage: caps entries, cuts names, survives a __proto__ key', () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < MAX_SKILL_USAGE_ENTRIES + 50; i++) big[`s${i}`] = { usageCount: i };
  assert.equal(parseSkillUsage({ skillUsage: big }).size, MAX_SKILL_USAGE_ENTRIES);
  const long = parseSkillUsage({ skillUsage: { ['n'.repeat(1000)]: { usageCount: 1 } } });
  assert.equal([...long.keys()][0]!.length, LIMITS.nameChars);
  const proto = parseSkillUsage(JSON.parse('{"skillUsage":{"__proto__":{"usageCount":4}}}'));
  assert.equal(({} as Record<string, unknown>)['usageCount'], undefined);
  assert.equal(proto.get('__proto__')?.uses, 4);
});
