import type { SubAgent } from './flow.ts';

// What the FlowStep agent (src/agents/flow-step.ts) needs to know about the step it was started for. Same process as the engine, so a plain map: instructions are authored text, the prompt
// travels as the message. A step interrupted by a restart loses its spec and fails; its run is marked failed then anyway.
export interface StepSpec { conversationId: string; instructions: string; model: string | null; thinking: string | null; skills: string[]; subAgents: SubAgent[]; /** sandbox, connectors, data, modules */ tools: boolean; /** tool ids the Assistant turned off (agents/tool-filter.ts) */ disabled?: string[] }
export const stepSpecs = new Map<string, StepSpec>();
