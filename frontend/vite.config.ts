import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The backend's own port, read from the repository-root `.env` the same
 * file `backend/src/config.ts` reads (`BACKEND_PORT`) -- so the dev proxy
 * below always targets whatever port the backend actually listens on,
 * without duplicating that value in a second place. Falls back to the
 * backend's own default (3001, `.env.example`) when no `.env` exists yet.
 */
function backendPort(): number {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(/^BACKEND_PORT=(\d+)/m);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return 3001;
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // passkey-kit (sdk 16 peer) and its generated contract clients must
    // share ONE @stellar/stellar-sdk copy -- two copies make every
    // `instanceof`-based XDR check inside the kit fail ("did not match the
    // provided type"). Dedupe onto this workspace's own 16.x install.
    dedupe: ["@stellar/stellar-sdk"],
  },
  optimizeDeps: {
    include: ["passkey-kit", "passkey-kit/storage"],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Every frontend fetch goes to `/api/*`; stripping the prefix here
      // means the browser only ever talks to its own origin (no CORS) and
      // the backend's own routes stay unprefixed (`/categories`,
      // `/providers/:id`, ...).
      "/api": {
        target: `http://localhost:${backendPort()}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
