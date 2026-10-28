import { loadProfile, type Profile } from './profile.ts';
import { connectedModels } from './providers.ts';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Thinking = typeof THINKING_LEVELS[number];
/** '' / null / undefined mean "default"; anything else must be a level. */
export const validThinking = (t: unknown) => t == null || t === '' || (THINKING_LEVELS as readonly unknown[]).includes(t);

/** Legacy: no UI sets the profile model any more, but an existing install may still have one. */
export const hasDefaultModel = () => !!loadProfile().model;
/** Can a chat start: a profile model, or else a connected company provider with models (the first available model is the fallback, see resolveRun). */
export const modelReady = () => {
  if (hasDefaultModel()) return true;
  try { return connectedModels().some((p) => p.models.length > 0); } catch { return false; } // a provider row the build cannot resolve must not break /api/me
};

/**
 * Who runs on what: model = conversation > team profile > the first available model (agents fall back to the orchestrator's), effort = conversation > team (orchestrator only).
 * A model without reasoning (or one we cannot look up) gets no level; pi-ai clamps levels a reasoning model lacks (xhigh, max).
 * (user_agent_prefs, the old per-user overrides, is no longer read; the table stays.)
 */
export function resolveRun(profile: Profile, convModel: string | undefined, models: { id: string; reasoning: boolean }[], convThinking?: string) {
  const level = (model: string | null | undefined, ...t: (string | null | undefined)[]) =>
    model && models.find((m) => m.id === model)?.reasoning ? (t.find((x) => x) as Thinking | undefined) : undefined;
  const model = convModel ?? profile.model ?? models[0]?.id;
  return {
    model,
    thinkingLevel: level(model, convThinking, profile.thinking),
    agents: Object.fromEntries(profile.agents.map((a) => [a.name, { model: a.model ?? undefined, thinkingLevel: level(a.model ?? model, a.thinking) }])),
  };
}
