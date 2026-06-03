import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone Webinar Creation Dashboard.
// Dev server on 5194 (next free port in the repo). `/api` is pre-wired to the
// future dedicated backend on :3005 (NOT built yet) so wiring real data later
// is a no-op change here. No /api calls fire until that backend exists.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5194,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3005',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.flushHeaders();
            }
          });
        },
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
