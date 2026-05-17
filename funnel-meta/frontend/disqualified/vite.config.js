import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'framer': ['framer-motion'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
