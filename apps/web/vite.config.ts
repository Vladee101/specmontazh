import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // в разработке SPA и API на одном origin, как в продакшене за nginx
    proxy: { '/api': 'http://127.0.0.1:3010' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
