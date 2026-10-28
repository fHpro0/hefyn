import { parseAgentManifest, type AgentManifest } from '../agent-manifest.ts';
import claude from './claude-acp.json' with { type: 'json' };
import codex from './codex-acp.json' with { type: 'json' };
import opencode from './opencode.json' with { type: 'json' };
import pi from './pi-acp.json' with { type: 'json' };

// The agents hefyn ships: agent manifests like any module adds (docs/MODULES.md, "Agent modules"). A broken one throws at startup.
export const BUILTIN_AGENTS: AgentManifest[] = [claude, codex, opencode, pi].map((m) => parseAgentManifest(m));
