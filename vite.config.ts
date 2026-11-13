import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Cross-origin isolation unlocks SharedArrayBuffer and fine-grained timers
// (docs/SPEC.md, D5). Keep in sync with public/_headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [svelte()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, headers: isolation },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    modulePreload: { polyfill: false },
    // Always emit .wasm as a real file, at any size, so dev and prod load it
    // the same way and it stays out of the JS budget.
    assetsInlineLimit: (file) => (file.endsWith('.wasm') ? false : undefined),
  },
});
