import { defineConfig, type OutputBundle, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const phase19ApiTarget = process.env.PHASE19_API_TARGET?.trim();
const buildSurface = process.env.CAPIRO_WEB_BUILD_SURFACE?.trim().toLowerCase() || 'universal';

const LEGACY_DISTRICT_NEXUS_UI = [
  'DistrictNexusPage.tsx',
  'DistrictNexusMap.tsx',
  'DistrictNexusDrawer.tsx',
  'DistrictNexusFilters.tsx',
  'DistrictNexusTable.tsx',
  'DistrictFederalMarketPanel.tsx',
];

const SHARED_DISTRICT_NEXUS_MODULES = [
  'district-nexus-api.ts',
  'district-nexus-format.ts',
  'priority-intelligence-api.ts',
  'priority-intelligence-format.ts',
  'supplier-footprint-api.ts',
];

function outputModuleIds(bundle: OutputBundle): string[] {
  return Object.values(bundle).flatMap((output) =>
    output.type === 'chunk'
      ? Object.keys(output.modules).map((id) => id.replaceAll('\\', '/'))
      : [],
  );
}

export function districtNexusBuildSurfaceGuard(surface = buildSurface): Plugin {
  return {
    name: 'district-nexus-build-surface-guard',
    generateBundle(_options, bundle) {
      if (surface !== 'vnext') return;
      const moduleIds = outputModuleIds(bundle);
      const forbidden = moduleIds.filter((id) =>
        LEGACY_DISTRICT_NEXUS_UI.some((file) =>
          id.endsWith(`/pages/intelligence/district-nexus/${file}`),
        ),
      );
      if (forbidden.length > 0) {
        this.error(`Legacy District Nexus UI reached vNext output:\n${forbidden.join('\n')}`);
      }
      const missingShared = SHARED_DISTRICT_NEXUS_MODULES.filter(
        (file) =>
          !moduleIds.some((id) => id.endsWith(`/pages/intelligence/district-nexus/${file}`)),
      );
      if (missingShared.length > 0) {
        this.error(
          `Shared District Nexus modules missing from vNext output:\n${missingShared.join('\n')}`,
        );
      }
    },
  };
}

export default defineConfig({
  // tailwindcss() only generates utilities for classes it finds via the
  // `@source` globs declared in outreach/v2/ui/tailwind.css — it has no
  // effect anywhere else in the app. That file also skips Tailwind's
  // preflight reset (imports theme.css + utilities.css, not the umbrella
  // "tailwindcss" import), because the legacy `theme.css` this app already
  // loads on every non-vnext route has its own global resets on
  // body/html/.ant-typography that a second reset would fight.
  plugins: [react(), tailwindcss(), districtNexusBuildSurfaceGuard()],
  define: {
    'import.meta.env.VITE_BUILD_WEB_SURFACE': JSON.stringify(buildSurface),
  },
  server: {
    port: 5173,
    host: true,
    // Serve /runtime-config.js from public/runtime-config.js in local dev.
    // Without this, SPA fallback can return index.html for script requests,
    // causing HTML-as-JS parse failures before React boot.
    fs: {
      strict: false,
    },
    // Phase 19's authenticated browser runner performs direct, same-origin
    // confidentiality probes in addition to the app's axios calls. Enable the
    // proxy only when the dedicated rehearsal explicitly supplies a target;
    // ordinary local development and every deployed build are unchanged.
    ...(phase19ApiTarget
      ? {
          proxy: {
            '/api': {
              target: phase19ApiTarget,
              changeOrigin: true,
            },
          },
        }
      : {}),
  },
  // The dev server uses esbuild's depOptimizer rather than Rollup's commonjs
  // plugin, so the build-time `commonjsOptions` block below doesn't help.
  // Explicitly pre-bundle @capiro/shared so esbuild rewrites the CJS
  // `exports.X = ...` form into named ESM exports the browser can import.
  //
  // Pre-bundling the package root does not cover its CJS subpaths. Include
  // each subpath imported at runtime by web pages so the dev server never
  // serves workspace CommonJS files directly to the browser.
  optimizeDeps: {
    include: [
      '@capiro/shared',
      '@capiro/shared/meri-skills',
      '@capiro/shared/client-registration-integrity',
      '@capiro/shared/funding-claim',
      '@capiro/strategy-verifier',
    ],
  },
  build: {
    // @capiro/shared compiles to CommonJS so that the NestJS CJS runtime can
    // `require()` it. Rollup's default commonjs handling skips workspace
    // packages, explicitly opting it in lets named exports come through.
    commonjsOptions: {
      // Rollup's commonjs plugin sees resolved file paths, not import
      // specifiers, so we match the workspace dist path here.
      include: [/packages\/(shared|strategy-verifier)\/dist/, /node_modules/],
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
