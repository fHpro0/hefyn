'use agent';
import { defineSkill, useModel, useSkill, useSubagent, type AgentProps } from '@flue/runtime';
import { stepSpecs } from '../assistants/step-spec.ts';
import { syncProviders } from '../server/agent-runtime.ts';
import { resolveRun } from '../server/agent-prefs.ts';
import { availableModels } from '../server/connectors.ts';
import { skillBundles } from '../server/assistants.ts';
import { loadProfile } from '../server/profile.ts';
import { userOfConversation } from '../server/usage.ts';
import { mountUserTools } from './mount.ts';

const TAIL = '\n\nYou are one step of an automated flow. There is no person to ask (you may consult your helpers, if you have any): do the task you are given and answer in exactly the format requested.';

// One agent step of a flow (src/assistants/hefyn-step.ts): `id` is a fresh u_<userId>_<ulid>; the engine put what the step wants into `stepSpecs`. Same access check and usage accounting as a chat turn.
export function FlowStep({ id }: AgentProps) {
  syncProviders();
  const spec = stepSpecs.get(id), userId = userOfConversation(id);
  if (!spec || !userId) throw new Error('This conversation is not a flow step.');
  const models = availableModels(userId);
  const run = resolveRun({ model: spec.model ?? loadProfile().model, thinking: spec.thinking, instructions: spec.instructions, skills: [], agents: spec.subAgents.map((a) => ({ name: a.name, description: a.description, model: a.model ?? null, thinking: a.thinking ?? null, instructions: a.instructions, skills: a.skills })) }, undefined, models);
  if (!run.model) throw new Error('No model configured: an admin must connect a provider and pick models.');
  useModel(run.model, run.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {});
  const off = new Set(spec.disabled ?? []);
  if (spec.tools) mountUserTools(userId, spec.conversationId, off);
  for (const a of spec.subAgents) {
    const r = run.agents[a.name]!;
    useSubagent({ name: a.name, description: a.description, ...(r.model ? { model: r.model } : {}), ...(r.thinkingLevel ? { thinkingLevel: r.thinkingLevel } : {}), agent: () => { a.skills.forEach((s) => useSkill(defineSkill(s))); return a.instructions; } });
  }
  for (const s of skillBundles(spec.skills.filter((k) => !off.has(`skill:${k}`)))) useSkill(defineSkill({ name: s.name, description: s.description, instructions: s.instructions, files: s.files }));
  return spec.instructions + TAIL;
}
