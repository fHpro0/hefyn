import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Static output goes next to the server build; the Hono app serves it. publicDir exposes assets/brand at /brand.
export default defineConfig({
  output: 'static',
  outDir: '../dist/web',
  publicDir: '../assets',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // dev: `bun run dev` runs the Flue/Hono server on 5173 next to this server.
    server: { proxy: { '/api': 'http://localhost:5173', '/agents': 'http://localhost:5173' } },
  },
});
