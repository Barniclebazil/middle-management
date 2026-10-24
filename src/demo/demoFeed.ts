import type { Activity, AgentSnapshot, AgentStatus } from '../shared/protocol.ts';

/** Length of one demo loop. */
export const LOOP_MS = 120_000;
/** How long a finished temp stays visible. */
export const TEMP_LINGER_MS = 10_000;

/** One stretch of activity: ends at `end` seconds into the loop. */
type Seg = readonly [end: number, activity: Activity, detail?: string];

interface StaffDef {
  id: string;
  title: string;
  project: string;
  segs: readonly Seg[];
  /** Seconds into the loop at which a human prompt arrives. */
  prompts: readonly number[];
}

interface TempDef {
  id: string;
  parent: string;
  title: string;
  spawn: number;
  done: number;
  segs: readonly Seg[];
}

const STAFF: readonly StaffDef[] = [
  {
    id: 'demo-1', title: 'Refactor auth middleware', project: 'api-server', prompts: [8, 100],
    segs: [
      [10, 'reading', 'src/auth/middleware.ts'], [22, 'searching', 'verifyToken'], [40, 'writing', 'src/auth/session.ts'],
      [52, 'running', 'npm test'], [60, 'thinking'], [95, 'idle'], [108, 'writing', 'src/auth/refresh.ts'], [120, 'reading', 'CHANGELOG.md'],
    ],
  },
  {
    id: 'demo-2', title: 'Fix flaky CI tests', project: 'web-app', prompts: [35],
    segs: [
      [14, 'reading', '.github/workflows/ci.yml'], [26, 'searching', 'retry flaky'], [34, 'running', 'npx playwright test'],
      [55, 'copier', 'npm run e2e -- --shard 1/4'], [90, 'idle'], [100, 'thinking'], [120, 'writing', 'e2e/login.spec.ts'],
    ],
  },
  {
    id: 'demo-3', title: 'Design landing page', project: 'marketing-site', prompts: [85],
    segs: [
      [18, 'thinking'], [30, 'reading', 'src/Hero.tsx'], [60, 'drawing', 'hero-illustration.svg'], [75, 'writing', 'styles/hero.css'],
      [90, 'running', 'npm run dev'], [105, 'shredding', 'rm -rf public/old-banner'], [120, 'reading', 'Footer.tsx'],
    ],
  },
  {
    id: 'demo-4', title: 'Migrate invoice schema', project: 'billing-service', prompts: [50],
    segs: [
      [20, 'planning', 'Plan migration steps'], [35, 'reading', 'db/schema.sql'], [50, 'writing', 'migrations/0042_add_invoice.sql'],
      [60, 'running', 'psql -f 0042_add_invoice.sql'], [70, 'thinking'], [92, 'needsYou', 'Approve DROP COLUMN legacy_id?'],
      [105, 'running', 'npm run migrate'], [120, 'writing', 'db/seed.sql'],
    ],
  },
  {
    id: 'demo-5', title: 'Audit dependencies', project: 'monorepo', prompts: [15],
    segs: [
      [10, 'reading', 'package.json'], [20, 'thinking'], [60, 'delegating', 'Auditing 2 packages'], [75, 'thinking'],
      [100, 'writing', 'AUDIT.md'], [120, 'running', 'npm audit'],
    ],
  },
  {
    id: 'demo-6', title: 'Write API docs', project: 'docs-site', prompts: [60],
    segs: [
      [15, 'reading', 'openapi.yaml'], [35, 'writing', 'docs/auth.md'], [50, 'searching', 'rate limit'],
      [62, 'researching', 'OpenAPI 3.1 examples'], [78, 'thinking'], [100, 'needsYou', 'Which tone for the guide?'],
      [110, 'writing', 'docs/errors.md'], [120, 'reading', 'README.md'],
    ],
  },
];

const TEMPS: readonly TempDef[] = [
  {
    id: 'demo-5-t1', parent: 'demo-5', title: 'Lockfile scout', spawn: 22, done: 46,
    segs: [[34, 'reading', 'package-lock.json'], [46, 'searching', 'deprecated']],
  },
  {
    id: 'demo-5-t2', parent: 'demo-5', title: 'Advisory researcher', spawn: 22, done: 52,
    segs: [[30, 'searching', 'CVE lodash'], [52, 'researching', 'lodash prototype pollution advisory']],
  },
];

/** Fixed first-seen time for staff, so archetype assignment never changes. */
const STAFF_EPOCH = 1_700_000_000_000;

function statusOf(activity: Activity): AgentStatus {
  if (activity === 'needsYou') return 'waiting';
  if (activity === 'idle') return 'idle';
  return 'working';
}

function segAt(segs: readonly Seg[], t: number): { seg: Seg; start: number } {
  let start = 0;
  for (const seg of segs) {
    if (t < seg[0] * 1000) return { seg, start };
    start = seg[0] * 1000;
  }
  const last = segs[segs.length - 1]!;
  return { seg: last, start: segs.length > 1 ? segs[segs.length - 2]![0] * 1000 : 0 };
}

/**
 * A deterministic, looping, scripted office for demos and screenshots. Stateless: the output is a pure
 * function of `now`, so any moment can be seeked to with `now = loopStart + seconds * 1000`.
 */
export class DemoFeed {
  snapshot(now: number): AgentSnapshot[] {
    const t = ((now % LOOP_MS) + LOOP_MS) % LOOP_MS;
    const loopStart = now - t;
    const out: AgentSnapshot[] = [];

    STAFF.forEach((s, i) => {
      const { seg, start } = segAt(s.segs, t);
      const lastPrompt = this.lastPrompt(s.prompts, t, loopStart);
      const a: AgentSnapshot = {
        id: s.id, kind: 'main', title: s.title, project: s.project,
        activity: seg[1], status: statusOf(seg[1]),
        since: loopStart + start, startedAt: STAFF_EPOCH + i * 60_000, lastPromptAt: lastPrompt,
      };
      if (seg[2] !== undefined) a.detail = seg[2];
      out.push(a);

      for (const tmp of TEMPS) {
        if (tmp.parent !== s.id) continue;
        const spawnMs = tmp.spawn * 1000;
        const doneMs = tmp.done * 1000;
        if (t < spawnMs || t >= doneMs + TEMP_LINGER_MS) continue;
        const isDone = t >= doneMs;
        const ts = segAt(tmp.segs, Math.min(t, doneMs - 1));
        const b: AgentSnapshot = {
          id: tmp.id, parentId: s.id, kind: 'temp', title: tmp.title, project: s.project,
          activity: ts.seg[1], status: isDone ? 'done' : 'working',
          since: loopStart + (isDone ? doneMs : Math.max(spawnMs, ts.start)), startedAt: loopStart + spawnMs,
        };
        if (ts.seg[2] !== undefined) b.detail = ts.seg[2];
        out.push(b);
      }
    });
    return out;
  }

  private lastPrompt(prompts: readonly number[], t: number, loopStart: number): number {
    let best: number | undefined;
    for (const p of prompts) if (p * 1000 <= t && (best === undefined || p > best)) best = p;
    if (best !== undefined) return loopStart + best * 1000;
    return loopStart - LOOP_MS + Math.max(...prompts) * 1000;
  }
}
