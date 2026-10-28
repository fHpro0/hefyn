import { type FlowNode, LIMITS, label, render } from './flow.ts';
import { compare } from './engine.ts';

// assistants.testStep: tries ONE step of a flow with a sample input, no model and no chat (docs/ASSISTANTS.md "Trying a step"). The input is what the editor's sample holds: a map of
// step id -> that step's output (the Chat message step's entry is `{text, files}`). It is adapted to the engine's shapes here: templates read the map as is; a Code step gets
// stdin `{"input": <the trigger's entry>, "steps": <every other entry, the step's own left out>}`, exactly what the engine writes.

export interface TestResult { ok: boolean; output?: { text?: string; json?: unknown }; stdout?: string; stderr?: string; error?: string; ms: number }
export interface CodeRun { stdout: string; stderr: string; exitCode: number; timedOut?: boolean }
export type RunCode = (r: { language: 'javascript' | 'python'; source: string; stdin: string; timeoutSec: number; node: string }) => Promise<CodeRun>;

export const MAX_TEST_SEC = 60;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function testStep(node: FlowNode | undefined, sample: Record<string, unknown>, trigger: FlowNode | undefined, runCode: RunCode): Promise<TestResult> {
  const t0 = Date.now(), done = (r: Omit<TestResult, 'ms'>): TestResult => ({ ...r, ms: Date.now() - t0 });
  if (!node) return done({ ok: false, error: 'That step is not in the flow.' });
  const c = node.config ?? {}, outputs = sample as Record<string, Record<string, unknown> | undefined>, tpl = (t: unknown) => render(typeof t === 'string' ? t : '', outputs);
  try {
    switch (node.type) {
      case 'template': return done({ ok: true, output: { text: tpl(c.text) } });
      case 'condition': {
        const result = compare(c.op, tpl(c.left), tpl(c.right));
        return done({ ok: true, output: { text: String(result), json: { result } } });
      }
      case 'router': {
        if (c.mode !== 'rules') return done({ ok: false, error: 'A router that decides with a model can only be tried inside a chat. Switch it to rules to try it here.' });
        const branches = (c.branches ?? []) as { id: string; rule?: { left: string; op: string; right: string } }[];
        const branch = branches.find((b) => b.rule && compare(b.rule.op, tpl(b.rule.left), tpl(b.rule.right)))?.id ?? 'else';
        return done({ ok: true, output: { text: branch, json: { branch } } });
      }
      case 'code': {
        if (String(c.source ?? '').length > LIMITS.source) return done({ ok: false, error: `The code can be at most ${LIMITS.source} characters.` });
        const timeoutSec = Math.min(MAX_TEST_SEC, Math.max(1, Number(c.timeoutSec) || 30));
        const first = (sample[trigger?.id ?? 'start'] ?? {}) as { text?: unknown; files?: unknown };
        const steps = Object.fromEntries(Object.entries(sample).filter(([k]) => k !== node.id && k !== trigger?.id));
        const r = await runCode({ language: c.language === 'python' ? 'python' : 'javascript', source: String(c.source ?? ''), node: node.id, timeoutSec,
          stdin: JSON.stringify({ input: { text: typeof first.text === 'string' ? first.text : '', files: Array.isArray(first.files) ? first.files : [] }, steps }) });
        const seen = { stdout: r.stdout, stderr: r.stderr };
        if (r.timedOut) return done({ ok: false, error: `The code ran longer than ${timeoutSec} seconds.`, ...seen });
        if (r.exitCode !== 0) {
          const lines = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean); // the line that names the error (Python: the last; Node: "Error: ..." above the stack)
          return done({ ok: false, error: `The code stopped with an error: ${(lines.find((l) => /^(?:\w+\.)*\w*(?:Error|Exception)\b/.test(l)) ?? lines.at(-1) ?? `exit ${r.exitCode}`).slice(0, 500)}`, ...seen });
        }
        let json: unknown;
        try { json = r.stdout.trim() ? JSON.parse(r.stdout) : undefined; } catch { return done({ ok: false, error: 'The code must print its result as JSON.', ...seen }); }
        return done({ ok: true, output: { text: r.stdout.trim(), ...(json !== undefined ? { json } : {}) }, ...seen });
      }
      default: return done({ ok: false, error: `"${label(node)}" can only be tried inside a chat.` });
    }
  } catch (e) { return done({ ok: false, error: msg(e) }); }
}
