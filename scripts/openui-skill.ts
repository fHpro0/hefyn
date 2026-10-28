// `bun run openui:skill`: writes src/cli-agents/openui-skill.md, the built-in `openui` skill every CLI agent gets (session-config.ts). Its body is the prompt generated from
// the chat's OpenUI library (web/src/components/openui/library.tsx), so the agent is taught exactly the components the chat can render. test/openui-skill.test.ts fails when the file is stale.
import { skillPrompt } from '../web/src/components/openui/library.tsx';

export const SKILL_FILE = new URL('../src/cli-agents/openui-skill.md', import.meta.url);
const description = 'Use whenever a reply has structured results (tables, comparisons, choices for the user, forms, status cards) to render them as interactive UI in the hefyn chat with an ```openui block.';
export const skillMarkdown = () => `---\nname: openui\ndescription: ${JSON.stringify(description)}\n---\n${skillPrompt().trim()}\n`;

if (import.meta.main) { await Bun.write(SKILL_FILE, skillMarkdown()); console.log(`wrote ${SKILL_FILE.pathname}`); }
