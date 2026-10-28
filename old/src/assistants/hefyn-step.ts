import { randomBytes } from 'node:crypto';
import { createAgentRouter } from '@flue/runtime/routing';
import { FlowStep } from '../agents/flow-step.ts';
import { db } from '../server/appdb.ts';
import { type StepSpec, stepSpecs } from './step-spec.ts';

// Runs one hefyn step: a Flue instance of the FlowStep agent, driven through its own router in this process (submit, then poll the settlement) like the web does for a chat.
// Every model request of the instance is access-checked (model-access.ts) and counted in usage like a chat turn.

const TIMEOUT_MS = () => Number(process.env.HEFYN_FLOW_STEP_TIMEOUT_MS) || 10 * 60_000;
const ulid = () => Date.now().toString(36).padStart(9, '0') + randomBytes(8).toString('hex');
let router: ReturnType<typeof createAgentRouter> | undefined;
const flue = () => (router ??= createAgentRouter(FlowStep)); // after start(): the router needs the configured runtime

export async function askHefyn(o: { userId: string; spec: StepSpec; prompt: string; signal: AbortSignal }): Promise<string> {
  const id = `u_${o.userId}_${ulid()}`, call = (path: string, init?: RequestInit) => flue().request(`/${id}${path}`, init);
  stepSpecs.set(id, o.spec);
  db.prepare('INSERT INTO assistant_steps (instance_id, conversation_id) VALUES (?,?)').run(id, o.spec.conversationId);
  const abort = () => void Promise.resolve(call('/abort', { method: 'POST' })).catch(() => {});
  o.signal.addEventListener('abort', abort, { once: true });
  try {
    const sent = await call('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'user', body: o.prompt }) });
    if (sent.status !== 202) throw new Error(`the model run was refused (HTTP ${sent.status})`);
    for (const end = Date.now() + TIMEOUT_MS(); Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
      if (o.signal.aborted) throw new Error('stopped');
      const r = await call('');
      if (!r.ok) throw new Error(`could not read the model's answer (HTTP ${r.status})`);
      const h = await r.json() as { messages?: { role: string; parts?: { type: string; text?: string }[] }[]; settlements?: { outcome: string; error?: unknown }[] };
      const s = h.settlements?.[0];
      if (!s) continue;
      if (s.outcome !== 'completed') throw new Error(`the model run ${s.outcome}${s.error ? `: ${typeof s.error === 'string' ? s.error : (s.error as Error).message ?? 'error'}` : ''}`);
      const last = h.messages?.filter((m) => m.role === 'assistant').at(-1);
      return (last?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
    }
    abort();
    throw new Error('the step took too long');
  } finally { o.signal.removeEventListener('abort', abort); stepSpecs.delete(id); }
}
