import {defineConfig} from 'vite';

// Preact via the automatic JSX runtime — no @vitejs/plugin-react, and crucially
// no `react -> preact/compat` alias. The host is pure Preact.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  // Single instance of Preact + signals so @remote-dom/preact's signals-based
  // renderer reacts to the receiver's updates (otherwise the remote tree renders
  // once, empty, and never updates).
  resolve: {
    dedupe: ['preact', '@preact/signals', '@preact/signals-core'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
