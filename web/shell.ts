import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyTheme } from './src/components/theme-apply.ts';

// The console is one HTML shell (web/src/entry.tsx picks the page from the URL). It is generated, not checked in, because the
// pre-paint theme script inlines applyTheme's source (via toString) so the user's cached theme is set before first paint.
// System mode follows the OS live; the server copy replaces the cache after load (syncTheme) and fires 'hefyn-theme'.
const theme = `(function(){var apply=${applyTheme};var d={mode:'system',accent:'default',base:'zinc',radius:'default',density:'comfortable',textSize:'default'};function a(){var t=d;try{t=Object.assign({},d,{mode:localStorage.getItem('hefyn-theme')||'system'},JSON.parse(localStorage.getItem('hefyn-theme-prefs')||'{}'))}catch(e){}apply(t)}a();matchMedia('(prefers-color-scheme: dark)').addEventListener('change',a);addEventListener('hefyn-theme',a)})()`;

// React Flow (the Assistants canvas) measures its nodes and pane with ResizeObservers and re-lays out in the same frame; browsers then report a
// harmless "ResizeObserver loop" error (the next frame delivers the sizes). Bun's dev overlay turns it into a full-page error that blocks every
// click, and it registers before any module, so the filter has to be the first script in the page.
const resizeLoop = `addEventListener('error',function(e){if(/^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(e.message))e.stopImmediatePropagation()},true)`;

// Brand links are relative to the generated file so Bun bundles them (hashed); the manifest's own /brand/ icons are served by the server.
const brand = '../../assets/brand';
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <link rel="icon" href="${brand}/hefyn-favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="${brand}/hefyn-favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="apple-touch-icon" href="${brand}/hefyn-apple-touch-icon.png" />
    <meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#09090B" media="(prefers-color-scheme: dark)" />
    <title>hefyn</title>
    <script>${resizeLoop}</script>
    <script>${theme}</script>
  </head>
  <body class="min-h-dvh">
    <script type="module" src="../src/entry.tsx"></script>
  </body>
</html>
`;

export async function writeShell() {
  const dir = join(import.meta.dir, '.gen');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.html');
  await Bun.write(file, html);
  return file;
}
