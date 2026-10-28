import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { cliPost, markTerminalUsed } from './CliChat';
import { ANSI } from './cli-palette';
import { isMac } from './ui';

// The agent's own terminal UI: xterm.js on the PTY stream. Colours come from the theme tokens and follow theme switches.
const APP_KEYS = new Set(['k', 'n', 'b', 'l', 'j']); // app shortcuts (⌘K palette, ⌘N, ⌘B, …) must not be swallowed by the terminal

function theme() {
  const probe = document.createElement('i');
  document.body.append(probe);
  const c = (v: string) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
  const t = { ...ANSI[document.documentElement.classList.contains('dark') ? 'dark' : 'light'], background: c('--background'), foreground: c('--foreground'), cursor: c('--foreground'), cursorAccent: c('--background'), selectionBackground: c('--muted'), selectionForeground: c('--foreground') };
  probe.remove();
  return t;
}

/** `account`: the sign-in terminal of Agent accounts (`claude auth login`, /agents/account/<id>) instead of a chat's agent (/agents/cli/<id>/terminal). */
export default function CliTerminal({ id, name, account = false, openBody, onEnd }: { id: string; name: string; agent?: string; account?: boolean; /** extra fields of the sign-in's open request: which agent, personal or team */ openBody?: object; onEnd?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const post = (path: string, body: unknown) => (account ? cliPost(id, path, body, 'account') : cliPost(id, `/terminal${path === '/open' ? '' : path}`, body));
  const [msg, setMsg] = useState(''); // a plain-words refusal or connection note, shown above the terminal
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 13, cursorBlink: true, theme: theme(), allowProposedApi: true, minimumContrastRatio: 4.5 }); // the ratio lifts the agent's own too-pale greys (dim text)
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.attachCustomKeyEventHandler((e) => !((e.metaKey || (e.ctrlKey && !isMac)) && APP_KEYS.has(e.key.toLowerCase()))); // false: xterm leaves the key to the app

    let es: EventSource | undefined, dead = false, buf = '', frame = 0, chain: Promise<unknown> = Promise.resolve(), resizeTimer: ReturnType<typeof setTimeout>;
    const flush = () => { frame = 0; const data = buf; buf = ''; chain = chain.then(() => post('/input', { data })).catch((x) => setMsg(x.message)); }; // one request at a time keeps keystrokes in order
    const sub = term.onData((d) => { buf += d; frame ||= requestAnimationFrame(flush); });
    const size = () => ({ cols: term.cols, rows: term.rows });
    const effectiveTheme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'); // 'system' is already resolved on <html>

    let w = el.clientWidth, h = el.clientHeight, raf = 0, sent = '';
    const refit = () => { // fit in a frame, not inside the callback: fitting changes layout and would re-trigger the observer
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        fit.fit();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { const s = JSON.stringify(size()); if (s !== sent) { sent = s; post('/resize', size()).catch(() => {}); } }, 150);
      });
    };
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      w = el.clientWidth; h = el.clientHeight;
      refit();
    });
    ro.observe(el);
    void document.fonts?.ready.then(() => !dead && refit()); // the mono font changes the cell size once it has loaded
    const mo = new MutationObserver(() => { term.options.theme = theme(); }); // theme switch: class and inline variables on <html>
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

    setMsg('');
    if (!account) markTerminalUsed(id);
    sent = JSON.stringify(size());
    post('/open', { ...size(), ...(account ? openBody : { theme: effectiveTheme() }) }).then(() => {
      if (dead) return;
      es = new EventSource(account ? `/agents/account/${id}/stream` : `/agents/cli/${id}/terminal/stream`);
      es.onopen = () => { term.reset(); setMsg(''); }; // every (re)connect starts with the scrollback, so start from a clean screen
      es.onmessage = (m) => term.write(Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)));
      es.onerror = () => { if (account) { es?.close(); onEnd?.(); } else setMsg('Connection lost. Reconnecting…'); }; // the sign-in ends with its process: nothing to reconnect to
      term.focus();
    }).catch((x) => setMsg(x.message));

    return () => { dead = true; cancelAnimationFrame(frame); cancelAnimationFrame(raf); clearTimeout(resizeTimer); es?.close(); ro.disconnect(); mo.disconnect(); sub.dispose(); term.dispose(); };
  }, [id, retry]);

  return (
    <div className="flex min-h-0 grow flex-col bg-background">
      {msg && <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/60 px-4 py-2 text-[13px] text-muted-foreground">
        <span>{msg}</span><Button type="button" variant="outline" size="xs" onClick={() => setRetry((n) => n + 1)}>Try again</Button></div>}
      {/* The frame and its padding sit out here: FitAddon measures the host's full box and would size the rows into any padding of its own, clipping the last one.
          The frame is absolutely placed so its height comes from the box, not from a flex chain that may be taller than the page. */}
      <div className="relative min-h-0 grow">
        <div className="absolute inset-3 box-border overflow-hidden rounded-md border border-foreground/20 bg-background p-3">
          <div ref={host} aria-label={`${name} terminal`} className="h-full w-full overflow-hidden [&_.xterm-viewport]:overflow-x-hidden" />
        </div>
      </div>
    </div>
  );
}
