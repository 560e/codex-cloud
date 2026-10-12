import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
  },
  server: {
    port: 18473,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:18474', ws: true },
    },
  },
});
