import { defineConfig } from 'vite';

export default defineConfig({
  base: '/lmi-r/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    proxy: {
      '/api-r': 'http://localhost:3100'
    }
  }
});
