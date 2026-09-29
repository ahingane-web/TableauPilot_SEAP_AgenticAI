import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.API_PORT ?? '4000';
const webPort = Number(process.env.WEB_PORT ?? '5173');

// Hostnames allowed to reach the dev server (Vite blocks unknown Host headers). This is
// needed when exposing the dev server through a tunnel (Cloudflare, ngrok, etc.), whose
// subdomains change per run — a leading-dot entry allows all subdomains of that domain.
// Override/extend via WEB_ALLOWED_HOSTS (comma-separated), e.g. ".ngrok-free.app,.loca.lt".
const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? '.trycloudflare.com')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// The Vite dev server (frontend) proxies /api to the backend Hono server so that
// the browser never talks to Tableau or the LLM gateway directly — all secrets
// stay server-side.
export default defineConfig({
  plugins: [react()],
  root: 'app',
  publicDir: false,
  server: {
    port: webPort,
    // Allow tunnel hostnames (default: any *.trycloudflare.com) through Vite's host check.
    allowedHosts,
    proxy: {
      // Match only real API routes (which all live under `/api/`). A bare `/api`
      // prefix would also intercept the client module import `/api.ts` and break
      // the dev bundle, so we anchor on the trailing slash.
      '^/api/': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
