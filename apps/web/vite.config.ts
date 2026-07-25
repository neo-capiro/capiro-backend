import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Serve /runtime-config.js from public/runtime-config.js in local dev.
    // Without this, SPA fallback can return index.html for script requests,
    // causing HTML-as-JS parse failures before React boot.
    fs: {
      strict: false,
    },
  },
  // The dev server uses esbuild's depOptimizer rather than Rollup's commonjs
  // plugin, so the build-time `commonjsOptions` block below doesn't help.
  // Explicitly pre-bundle @capiro/shared so esbuild rewrites the CJS
  // `exports.X = ...` form into named ESM exports the browser can import.
  optimizeDeps: {
    include: ['@capiro/shared'],
  },
  build: {
    // @capiro/shared compiles to CommonJS so that the NestJS CJS runtime can
    // `require()` it. Rollup's default commonjs handling skips workspace
    // packages, explicitly opting it in lets named exports come through.
    commonjsOptions: {
      // Rollup's commonjs plugin sees resolved file paths, not import
      // specifiers, so we match the workspace dist path here.
      include: [/packages\/shared\/dist/, /node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        // Keep the map engine in a chunk of its own.
        //
        // React.lazy is this app's ONLY chunk-splitting mechanism, and the
        // client-profile import chain (ClientWorkspacePage -> ClientProfilePage
        // -> IntelligenceTab) is fully eager. The District Nexus widget lives in
        // that chain, so a single value-import from the map page would drag
        // maplibre-gl into the entry bundle with no build error.
        //
        // This is defence in depth, not the primary guard: naming the chunk
        // keeps maplibre out of the entry chunk even if something reaches it,
        // while src/bundle-boundaries.test.ts is what actually fails the build
        // when an eager module starts depending on it.
        //
        // Function form, not the object form. The object form makes Rollup
        // RESOLVE every listed module id, so `{ maplibre: ['maplibre-gl'] }`
        // fails the build outright while the package is not installed — and it
        // is not installed yet. This form simply never matches until it exists.
        manualChunks(id: string) {
          if (/node_modules[\\/]maplibre-gl[\\/]/.test(id)) return 'maplibre';
          return undefined;
        },
      },
    },
    // The maplibre chunk is legitimately large; the default 500 kB warning
    // would be permanent noise. Set high enough to stay quiet for it, low
    // enough that a genuinely runaway chunk still says so.
    chunkSizeWarningLimit: 1200,
  },
});
