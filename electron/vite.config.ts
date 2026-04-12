import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const VITE_DEV_PORT_FILE = path.join(__dirname, '.vite-dev-port');

/** Write bound port so Electron main can load the correct dev server URL. */
function viteDevPortFilePlugin(): Plugin {
  return {
    name: 'vite-dev-port-file',
    configureServer(server) {
      try {
        fs.unlinkSync(VITE_DEV_PORT_FILE);
      } catch {
        /* ignore */
      }
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        const port =
          addr && typeof addr === 'object' && 'port' in addr
            ? (addr as { port: number }).port
            : null;
        if (port != null) {
          fs.writeFileSync(VITE_DEV_PORT_FILE, String(port), 'utf8');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), viteDevPortFilePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
