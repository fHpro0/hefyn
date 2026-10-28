// A leading `---` YAML block (SKILL.md and friends) never goes through the rich editor: split it off, join it back verbatim.
const FM = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  const m = FM.exec(src);
  return m ? { frontmatter: m[0], body: src.slice(m[0].length) } : { frontmatter: '', body: src };
}

export const joinFrontmatter = (frontmatter: string, body: string) => frontmatter + body;

/** Why the visual editor would lose part of this Markdown body (it drops raw HTML, footnotes, link definitions); undefined when safe. Conservative: indented code counts as text. */
export function visualUnsafe(body: string): string | undefined {
  let fence = ''; // the open fence marker; fenced lines are code, not markup
  const text = body.split(/\r?\n/).filter((l) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) { if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = ''; return false; }
    if (m) { fence = m[1]!; return false; }
    return true;
  }).join('\n').replace(/(`+)[^`]*?\1/g, ''); // inline code spans
  if (/<!--|<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/.test(text)) return 'it uses HTML, which the visual editor would drop.';
  if (/\[\^[^\]\s]+\]/.test(text)) return 'it has footnotes, which the visual editor would garble.';
  if (/^ {0,3}\[[^\]]+\]:\s*\S/m.test(text)) return 'it has link definitions, which the visual editor would drop.';
}
