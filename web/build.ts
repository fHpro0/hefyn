import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import tailwind from 'bun-plugin-tailwind';
import { writeShell } from './shell.ts';

// Builds the console into dist/web (replaces `astro build`): index.html plus hashed, split JS/CSS. src/web.ts serves every page URL
// as that index.html. assets/brand is copied to /brand (the web manifest and the components link to it by absolute path).
const out = join(import.meta.dir, '../dist/web');
const t = performance.now();
rmSync(out, { recursive: true, force: true });
const r = await Bun.build({ entrypoints: [await writeShell()], outdir: out, minify: true, splitting: true, publicPath: '/', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [tailwind] });
for (const l of r.logs) console.log(l.message);
if (!r.success) process.exit(1);
cpSync(join(import.meta.dir, '../assets/brand'), join(out, 'brand'), { recursive: true });
console.log(`console built in ${Math.round(performance.now() - t)} ms: ${r.outputs.length} files in dist/web`);
