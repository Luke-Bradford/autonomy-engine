import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.SERVER_PORT ?? '8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // `ws: true` proxies the WebSocket upgrade for the P6 live-run tail
      // (`/api/runs/:id/events/stream`) as well as the REST calls under `/api`.
      '/api': { target: `http://127.0.0.1:${SERVER_PORT}`, ws: true },
      '/health': `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
});
