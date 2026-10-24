// Minimal entry for the bundling check (plan row 6.2). Bundled by dev/sdk-bundle-check.mjs to CommonJS, then run with
// plain node. Proves that @anthropic-ai/claude-agent-sdk survives esbuild's cjs/node18 treatment, the same as the
// extension bundle, and that a one-shot query works against an external Claude Code binary.
import { query } from '@anthropic-ai/claude-agent-sdk';

const bin =
  process.env.CLAUDE_BIN ??
  '/path/to/claude';

// Drop markers of the surrounding Claude Code session (the check is usually run from inside one).
const env: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_PID') continue;
  env[k] = v;
}

async function main(): Promise<void> {
  let text = '';
  let cost = 0;
  for await (const msg of query({
    prompt: 'Reply with the word pong',
    options: {
      model: 'haiku',
      cwd: process.env.SPIKE_CWD ?? process.cwd(),
      pathToClaudeCodeExecutable: bin,
      settingSources: [],
      permissionMode: 'default',
      maxTurns: 2,
      maxBudgetUsd: 0.1,
      persistSession: false,
      env,
    },
  })) {
    if (msg.type === 'result') {
      cost = msg.total_cost_usd;
      if (msg.subtype === 'success') text = msg.result;
      else throw new Error(`query failed: ${msg.subtype}`);
    }
  }
  console.log(`bundle-check reply: ${JSON.stringify(text)} cost=${cost}`);
  if (!/pong/i.test(text)) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
