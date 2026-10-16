import { rx } from './rules.ts';

// Prompt-injection heuristic (port of the sidecar's `Heuristic` guard): phrase patterns for instructions aimed at an AI agent.
// Laya (model based) was never wired in.
const PHRASES = [
  String.raw`(?i)(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)`,
  String.raw`(?i)(reveal|print|show|repeat)\s+(me\s+)?(your|the)\s+(system\s+prompt|hidden\s+instructions)`,
  String.raw`(?i)you\s+are\s+now\s+(in\s+)?(developer|dan|jailbreak)`,
  String.raw`(?i)new\s+instructions\s*:`,
].map((p) => rx(p));

export interface GuardVerdict { flagged: boolean; score: number; reason: string }

export function guard(text: string): GuardVerdict {
  const hit = PHRASES.some((re) => re.test(text));
  return { flagged: hit, score: hit ? 1 : 0, reason: hit ? 'heuristic: instruction-like phrase aimed at an AI agent' : 'heuristic: clean' };
}
