// Prompt-injection heuristic for untrusted hub content: phrase patterns for instructions aimed at an AI agent.
const PHRASES = [
  /(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/iu,
  /(reveal|print|show|repeat)\s+(me\s+)?(your|the)\s+(system\s+prompt|hidden\s+instructions)/iu,
  /you\s+are\s+now\s+(in\s+)?(developer|dan|jailbreak)/iu,
  /new\s+instructions\s*:/iu,
];

export const guard = async (text: string): Promise<{ flagged: boolean; score: number; reason: string }> => {
  const hit = PHRASES.some((re) => re.test(text));
  return { flagged: hit, score: hit ? 1 : 0, reason: hit ? 'heuristic: instruction-like phrase aimed at an AI agent' : 'heuristic: clean' };
};
