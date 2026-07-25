/**
 * Static bundle-boundary gate.
 *
 * This repo has no `manualChunks`-driven code splitting to rely on and, until
 * now, no bundle-size gate of any kind: no size-limit, no bundlesize, no
 * visualizer. `React.lazy` is the only real chunk-splitting mechanism, and the
 * rule that keeps the map engine out of the entry bundle — "nothing eagerly
 * reachable from main.tsx may import maplibre-gl" — was enforced by nothing but
 * good intentions.
 *
 * That rule is easy to break silently. The client-profile chain
 * (ClientWorkspacePage -> ClientProfilePage -> IntelligenceTab) is fully eager,
 * and the District Nexus widget lives inside it. One `import { FOO } from
 * '../../intelligence/district-nexus/DistrictNexusMap.js'` in that widget pulls
 * a multi-megabyte WebGL library into the initial download, type-checks
 * perfectly, and produces no build error.
 *
 * So this walks the STATIC import graph from the real entrypoint and fails if it
 * reaches the map engine. Dynamic `import()` is treated as a chunk boundary and
 * is not traversed — that is exactly the boundary we want people to use.
 *
 * It is deliberately a static analysis rather than a built-output assertion: it
 * needs no `vite build`, so it runs in the same second as every other unit test
 * and gives a precise import path when it fails.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(SRC, 'main.tsx');

/** Packages that must never be eagerly reachable from the entrypoint. */
const FORBIDDEN_EAGER = ['maplibre-gl', '@vis.gl/react-maplibre', 'react-map-gl', 'leaflet'];

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Resolve a relative specifier to a real file, honouring the repo's `.js` suffixes. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  // Source is authored with `.js` suffixes that point at `.ts`/`.tsx` on disk.
  const stripped = base.replace(/\.js$/, '');
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = stripped + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Static import specifiers only.
 *
 * Skips `import type {...}` (erased at build time, so it cannot pull code in)
 * and `import(...)` (a chunk boundary). Matching `from '...'` also catches
 * `export ... from '...'`, which re-exports and therefore does pull code in.
 */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  const withoutTypeImports = source.replace(/import\s+type\s+[^;]*?;/g, '');
  const re = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutTypeImports)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

interface Walk {
  reached: Map<string, string[]>;
  bare: Map<string, string[]>;
}

function walkEagerGraph(entry: string): Walk {
  const reached = new Map<string, string[]>();
  const bare = new Map<string, string[]>();
  const stack: Array<{ file: string; path: string[] }> = [{ file: entry, path: [entry] }];

  while (stack.length) {
    const { file, path } = stack.pop()!;
    if (reached.has(file)) continue;
    reached.set(file, path);

    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const spec of staticSpecifiers(source)) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target && !reached.has(target)) stack.push({ file: target, path: [...path, target] });
        continue;
      }
      // Bare specifier: a package. Record the first path that reached it.
      if (!bare.has(spec)) bare.set(spec, [...path, spec]);
    }
  }

  return { reached, bare };
}

describe('eager bundle boundaries', () => {
  const walk = walkEagerGraph(ENTRY);

  test('the entrypoint resolves and the graph is non-trivial', () => {
    // Guards the guard: a resolver regression that walked nothing would make
    // every assertion below vacuously pass.
    expect(existsSync(ENTRY)).toBe(true);
    expect(walk.reached.size).toBeGreaterThan(20);
  });

  test.each(FORBIDDEN_EAGER)('%s is not eagerly reachable from main.tsx', (pkg) => {
    const path = walk.bare.get(pkg);
    const trail = path
      ? path.map((p) => p.replace(SRC, 'src')).join('\n  -> ')
      : '(not reached)';
    expect(
      path,
      `${pkg} became eagerly reachable from the entrypoint, so it now ships in the initial ` +
        `download. Put it behind React.lazy instead. Import path:\n  ${trail}\n`,
    ).toBeUndefined();
  });

  test('the district-nexus map module is not eagerly reachable', () => {
    // The widget in the (eager) client-profile chain may import TYPES from the
    // map feature, never values.
    const offenders = [...walk.reached.keys()].filter((f) =>
      /district-nexus[\\/](DistrictNexusMap|DistrictNexusPage)/.test(f),
    );
    expect(offenders.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });
});
