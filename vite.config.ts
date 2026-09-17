import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: './postcss.config.js',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  // Tauri expects a fixed port and doesn't open a browser
  server: {
    port:        isTauri ? 5173 : undefined,
    strictPort:  isTauri,
    hmr:         process.env.DISABLE_HMR !== 'true',
    // In Tauri dev mode the Vite server is separate from the Express sidecar;
    // proxy /api/* so the frontend can reach the sidecar running on :7331.
    proxy: isTauri ? { '/api': 'http://localhost:7331' } : undefined,
  },
  build: {
    // Target Chrome 105 + Safari 13 (Tauri's WebView baseline)
    target:    isTauri ? ['es2021', 'chrome105', 'safari13'] : 'modules',
    minify:    process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          charts: ['recharts'],
          motion: ['motion'],
          mantine: ['@mantine/core', '@mantine/hooks', '@mantine/modals', '@mantine/notifications', '@mantine/spotlight'],
        },
      },
    },
  },
});
