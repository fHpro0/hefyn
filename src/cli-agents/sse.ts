/** Pass a server-sent-event stream through byte for byte. `onEvent` sees each JSON data payload (usage counting); `onEnd` runs once when the stream ends, fails or the reader goes away. */
export function watchSse(src: ReadableStream<Uint8Array>, onEvent: (e: any) => void, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = src.getReader(), dec = new TextDecoder();
  let buf = '', ended = false;
  const end = () => { if (!ended) { ended = true; onEnd(); } };
  const see = (block: string) => {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (line) try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* not JSON ([DONE]) */ }
  };
  const feed = (text: string) => {
    buf += text;
    for (let m; (m = /\r?\n\r?\n/.exec(buf)); ) { see(buf.slice(0, m.index).replace(/\r/g, '')); buf = buf.slice(m.index + m[0].length); }
  };
  return new ReadableStream({
    async pull(ctrl) {
      const r = await reader.read().catch((e) => { end(); ctrl.error(e); return undefined; });
      if (!r) return;
      if (r.done) { if (buf.trim()) see(buf.replace(/\r/g, '')); end(); return ctrl.close(); }
      feed(dec.decode(r.value, { stream: true }));
      ctrl.enqueue(r.value);
    },
    cancel: (r) => { end(); return reader.cancel(r); },
  });
}
