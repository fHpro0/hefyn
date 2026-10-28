'use agent';
import { defineSkill, useModel, useSkill, useSubagent, useTool, type AgentProps } from '@flue/runtime';
import * as v from 'valibot';
import { acceptingChats, hasAcceptingChats, isRelayed, messageChat } from '../server/chat-links.ts';
import { syncProviders } from '../server/agent-runtime.ts';
import { resolveRun } from '../server/agent-prefs.ts';
import { availableModels, conversationModel, conversationThinking } from '../server/connectors.ts';
import { connectedModels } from '../server/providers.ts';
import { assistantIdOf, getAssistant, skillBundles } from '../server/assistants.ts';
import { offOf } from './tool-filter.ts';
import { installedFor } from '../server/hub.ts';
import { loadProfile, type AgentRow } from '../server/profile.ts';
import { userOfConversation } from '../server/usage.ts';
import { mountUserTools } from './mount.ts';
import { moduleInstructions } from '../modules/active.ts';
import { agentModules } from '../modules/light.ts'; // the light halves of the optional modules (the full ones pull in routes and auth)

// Not exported: the build registers every exported capitalized function as an agent.
function agentFor(a: AgentRow) {
  return () => {
    a.skills.forEach((s) => useSkill(defineSkill(s)));
    return a.instructions;
  };
}

// `id` is the conversation id u_<userId>_<ulid>.
export function Configurable({ id }: AgentProps) {
  syncProviders();
  const profile = loadProfile(assistantIdOf(id)); // the conversation's Assistant, else the default one
  const userId = userOfConversation(id);
  const models = userId ? availableModels(userId) : connectedModels().flatMap((p) => p.models);
  const run = resolveRun(profile, conversationModel(id), models, conversationThinking(id));
  const model = run.model; // the model is access-checked when the request is sent (model-access.ts)
  if (!model) throw new Error('No model configured: an admin must connect a provider and pick models.');
  const level = run.thinkingLevel;
  useModel(model, level ? { thinkingLevel: level } : {});
  const off = offOf(getAssistant(assistantIdOf(id))?.flow); // what the Assistant turned off in its Tools tab
  if (userId) mountUserTools(userId, id, off); // sandbox, connectors, data collections, modules' tools
  // Opt-in chat-to-chat messaging (own chats that switched it on). A chat answering such a message gets no tools: depth 1.
  if (userId && !isRelayed(id) && hasAcceptingChats(userId, id)) {
    useTool({
      name: 'list_chats',
      description: 'List the user’s other chats that accept messages from this chat (id and title).',
      input: v.object({}),
      async run() { return JSON.stringify(acceptingChats(userId, id)); },
    });
    useTool({
      name: 'message_chat',
      description: 'Send a message to one of the user’s other chats (an id from list_chats) and get that chat’s answer back. Only chats that accept messages can be reached.',
      input: v.object({ chat: v.string(), message: v.string() }),
      async run({ data }) { return JSON.stringify(await messageChat({ userId, from: id, chat: data.chat, message: data.message })); },
    });
  }
  for (const a of profile.agents) {
    const r = run.agents[a.name];
    useSubagent({ name: a.name, description: a.description, ...(r.model ? { model: r.model } : {}), ...(r.thinkingLevel ? { thinkingLevel: r.thinkingLevel } : {}), agent: agentFor(a) });
  }
  // The Assistant's own skills (Hub skill packages the admin picked); they go first, so a name clash with a user's install keeps the admin's.
  const assigned = new Set<string>();
  for (const s of skillBundles(profile.skills.filter((k) => !off.has(`skill:${k}`)))) { assigned.add(s.name); useSkill(defineSkill({ name: s.name, description: s.description, instructions: s.instructions, files: s.files })); }
  // Hub installs (team + own) stay available on top of the profile's agents. MCP entries arrive through the Connectors path above. The profile's agents win name collisions.
  if (userId) {
    const h = installedFor(userId);
    const taken = new Set(profile.agents.map((a) => a.name));
    for (const w of h.warnings) console.warn(`[hefyn] hub: ${w}`);
    for (const s of h.skills.filter((x) => !assigned.has(x.name))) useSkill(defineSkill({ name: s.name, description: s.description, instructions: s.instructions, files: s.files }));
    for (const a of h.agents) {
      if (taken.has(a.name)) { console.warn(`[hefyn] hub: agent "${a.name}" skipped: the profile already defines it`); continue; }
      const level = a.thinking && models.find((m) => m.id === (a.model ?? model))?.reasoning ? a.thinking : undefined; // like profile agents: only for models that think
      useSubagent({ name: a.name, description: a.description, ...(a.model ? { model: a.model } : {}), ...(level ? { thinkingLevel: level as any } : {}),
        agent: () => { h.skills.filter((s) => a.skills.includes(s.name)).forEach((s) => useSkill(defineSkill({ name: s.name, description: s.description, instructions: s.instructions, files: s.files }))); return a.instructions; } });
    }
  }
  // Modules' instruction sections (projects: the project's standing instructions).
  return [profile.instructions, ...moduleInstructions({ conversationId: id }, agentModules).map((s) => `## ${s.title}\n\n${s.text}`)].join('\n\n');
}
