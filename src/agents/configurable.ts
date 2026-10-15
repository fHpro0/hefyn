'use agent';
import { defineSkill, useMcpConnection, useModel, useSandbox, useSkill, useSubagent, type AgentProps } from '@flue/runtime';
import { syncProviders } from '../server/agent-runtime.ts';
import { conversationModel } from '../server/connectors.ts';
import { mountable } from '../server/mcp.ts';
import { installedFor } from '../server/hub.ts';
import { loadProfile, type AgentRow } from '../server/profile.ts';
import { containerSandboxFactory } from '../server/container-sandbox.ts';
import { overQuota, playwrightEnabled, playwrightFetch, playwrightUrl, shellEnabled } from '../server/runner.ts';
import { userSandboxFactory } from '../server/storage-sandbox.ts';
import { userOfConversation } from '../server/usage.ts';

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
  const profile = loadProfile();
  const model = conversationModel(id) ?? profile.model; // the model is access-checked when the request is sent (redact.ts)
  if (!model) throw new Error('No model configured: an admin must connect a provider and pick models.');
  useModel(model);
  const userId = userOfConversation(id);
  if (userId) {
    // One mode per user: sandbox.shell + a runner means the container (shell tools, and the Files API goes through it too);
    // everyone else gets the file-only sandbox on the confined host dir.
    useSandbox(shellEnabled(userId)
      ? containerSandboxFactory({ userId, conversationId: id, overQuota: () => overQuota(userId) })
      : userSandboxFactory({ userId, conversationId: id }), { cwd: '/files' });
    if (playwrightEnabled(userId)) useMcpConnection({ name: 'playwright', url: playwrightUrl(userId, id), transport: 'streamable-http', fetch: playwrightFetch(userId, id), optional: true });
    for (const m of mountable(userId)) useMcpConnection({ name: m.name, url: m.url, transport: m.transport, auth: m.token, optional: true });
  }
  for (const a of profile.agents) {
    useSubagent({ name: a.name, description: a.description, ...(a.model ? { model: a.model } : {}), agent: agentFor(a) });
  }
  // Hub installs (team + own). MCP entries arrive through the Connectors path above. Profile agents win name collisions.
  if (userId) {
    const h = installedFor(userId);
    const taken = new Set(profile.agents.map((a) => a.name));
    for (const w of h.warnings) console.warn(`[hefyn] hub: ${w}`);
    for (const s of h.skills) useSkill(defineSkill({ name: s.name, description: s.description, instructions: s.instructions, files: s.files }));
    for (const a of h.agents) {
      if (taken.has(a.name)) { console.warn(`[hefyn] hub: agent "${a.name}" skipped: the profile already defines it`); continue; }
      useSubagent({ name: a.name, description: a.description, ...(a.model ? { model: a.model } : {}),
        agent: () => { h.skills.filter((s) => a.skills.includes(s.name)).forEach((s) => useSkill(defineSkill({ name: s.name, description: s.description, instructions: s.instructions, files: s.files }))); return a.instructions; } });
    }
  }
  return profile.instructions;
}
