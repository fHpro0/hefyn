// rehype plugin: wraps every word of the prose in <span class="hf-word" style="--i:N"> so new text can float in (app.css). Code stays untouched.
interface Node { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] }

/** `delays` outlives the renders of one message: a word's --i is fixed the first time it is seen (0,1,2… counted from the old end), so a re-render never reshuffles the stagger. */
export function floatWords({ delays = [] }: { delays?: number[] } = {}) {
  return (tree: Node) => {
    let n = 0;
    const base = delays.length;
    const span = (child: Node, i: number): Node => ({ type: 'element', tagName: 'span', properties: { className: ['hf-word'], style: `--i:${(delays[i] ??= Math.max(0, i - base))}` }, children: [child] });
    const walk = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.flatMap((c): Node[] => {
        if (c.type === 'element') { if (c.tagName === 'code') return [span(c, n++)]; if (c.tagName !== 'pre') walk(c); return [c]; } // inline code floats in as one unit, a code block stays as it is
        if (c.type !== 'text' || !c.value) return [c];
        return c.value.split(/(\s+)/).filter(Boolean).map((p) => (/^\s+$/.test(p) ? { type: 'text', value: p } : span({ type: 'text', value: p }, n++)));
      });
    };
    walk(tree);
  };
}
