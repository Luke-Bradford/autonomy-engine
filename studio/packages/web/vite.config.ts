import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.SERVER_PORT ?? '8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
      '/health': `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
});
