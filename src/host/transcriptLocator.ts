// Maps an agent to its transcript file using the watcher's latest session list. No `vscode` import.
import type { SessionInfo } from '../claude/types.ts';
import type { CaseAgent } from '../manager/transcriptReader.ts';

/**
 * A main agent's transcript is its session's file. A temp (subagent) has id `<sessionId>/<agentId>` and carries its
 * parent's `sessionId`; its transcript is that session's subagent file. Undefined when the session is not listed.
 */
export function locateTranscript(sessions: readonly SessionInfo[], agent: CaseAgent): string | undefined {
  const sid = agent.sessionId ?? (agent.kind === 'main' ? agent.id : agent.id.split('/')[0]);
  if (sid === undefined) return undefined;
  const session = sessions.find((s) => s.sessionId === sid);
  if (!session) return undefined;
  if (agent.kind !== 'temp') return session.transcriptPath;
  const slash = agent.id.indexOf('/');
  const subId = slash >= 0 ? agent.id.slice(slash + 1) : agent.id;
  return session.subagents.find((s) => s.agentId === subId)?.path;
}
