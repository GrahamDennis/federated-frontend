import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the built bundle works when served from an unknown
  // subpath (the registry's content endpoint, /content/<digest>/), not just from
  // the origin root.
  base: './',
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
  },
});
