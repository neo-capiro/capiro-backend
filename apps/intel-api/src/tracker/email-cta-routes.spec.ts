/**
 * Gate V b-3 / V-5 — the email-CTA route contract.
 *
 * RB-03 was a CTA that pointed at `/clients/<id>?tab=tracker`, a route that has
 * never existed: `apps/web/src/App.tsx` only ever declared `/clients`. Every
 * recipient who clicked "Open in LegiWatch" in a tracker email landed on a blank
 * SPA. Nothing caught it, because nothing connects the string an email renderer
 * builds to the route table the SPA declares — they live in different apps and
 * are only ever compared by a human reading both.
 *
 * This test is that connection. It is deliberately STATIC rather than
 * render-based: rendering only proves the CTAs a fixture happens to exercise,
 * while scanning the source proves every CTA that *can* be built, including
 * from a renderer added tomorrow. Gate V asks for exhaustive, not sampled.
 *
 * It covers BOTH digest rails, which is the other thing a human comparison
 * misses — they are near-identical, independently scheduled, and drain
 * different tables:
 *   intel-api  -> IntelAlertService      -> intel_alert_digest_queue
 *   apps/api   -> TrackerAlertService    -> alert_digest_queue
 *
 * If this test fails, do not relax the matcher. Either the CTA is wrong, or the
 * SPA route was removed and every previously-sent email now dead-links.
 */
// apps/intel-api exposes jest's globals via @types/jest (no @jest/globals dep),
// matching every other spec in this tree.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const APP_TSX = join(REPO_ROOT, 'apps/web/src/App.tsx');

/** Trees that may legitimately contain an outbound email/SMS CTA. */
const CTA_SOURCE_DIRS = [
  join(REPO_ROOT, 'apps/intel-api/src'),
  // Scoped to the tracker notification rail: `${base}` is a wildly overloaded
  // identifier in apps/api (MCP OAuth redirects, onboarding slugs, memory
  // interview links), so a repo-wide sweep there is all false positives.
  join(REPO_ROOT, 'apps/api/src/tracker'),
];

// ---------------------------------------------------------------------------
// SPA route table
// ---------------------------------------------------------------------------

/** Every `path=` declared on a <Route> in App.tsx, including multi-line JSX. */
export function extractRoutePaths(appTsx: string): string[] {
  const paths = new Set<string>();
  for (const m of appTsx.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths];
}

/**
 * A declared route pattern -> matcher. Handles `:param` segments and a trailing
 * `*` splat, which is all React Router v6 syntax App.tsx actually uses.
 */
export function routeMatcher(pattern: string): RegExp {
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') return '.*';
      if (seg.startsWith(':')) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${escaped}/?$`);
}

/**
 * Nested <Route> children in App.tsx are declared relative to their parent
 * (e.g. `personal` under `/settings`). Only absolute paths are addressable as
 * a CTA target, so relative children are joined onto every plausible parent.
 * Simplest correct approach: treat any non-absolute path as also valid when
 * suffixed to an absolute one.
 */
export function buildResolvableRoutes(paths: string[]): string[] {
  const absolute = paths.filter((p) => p.startsWith('/'));
  const relative = paths.filter((p) => !p.startsWith('/'));
  const out = new Set(absolute);
  for (const parent of absolute) {
    for (const child of relative) out.add(`${parent.replace(/\/$/, '')}/${child}`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// CTA extraction
// ---------------------------------------------------------------------------

export interface FoundCta {
  file: string;
  line: number;
  /** The path portion only, query string and template holes stripped. */
  path: string;
  raw: string;
}

/**
 * Pull in-app CTA paths out of a source file. Matches the two idioms both rails
 * use to build an absolute app URL:
 *     `${appBaseUrl()}/legiwatch?...`
 *     `${base}/legiwatch?...`          (base = TRACKER_APP_BASE_URL)
 */
export function extractCtas(file: string, source: string): FoundCta[] {
  const found: FoundCta[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\$\{(?:appBaseUrl\(\)|base)\}([^`"'\s]*)/g)) {
      const raw = m[1] ?? '';
      // Skip non-path continuations: `${base}-1`, `${base}?foo`, `${base}` alone.
      if (!raw.startsWith('/')) continue;
      // Strip the query string, then any interpolated segment: a path whose
      // final segment is `${...}` is a parameterised route (/program-elements/:code).
      const path = (raw.split('?')[0] ?? '').replace(/\$\{[^}]*\}/g, ':param');
      found.push({ file, line: i + 1, path, raw });
    }
  });
  return found;
}

/**
 * CTAs whose path is a VARIABLE, not a literal — `${appBaseUrl()}${pe.href}`.
 * A static sweep cannot see through these, and silently skipping them is how a
 * dead link ships. Each must be declared here with the literal paths the
 * variable can actually take, and those get route-checked like any other.
 *
 * Keyed by the expression exactly as it appears in source.
 */
export const DYNAMIC_CTA_SOURCES: Record<string, { producedBy: string; paths: string[] }> = {
  '${pe.href}': {
    producedBy:
      'apps/intel-api/src/intel-alert/intel-alert.service.ts:549 — `evPe.href ?? `/program-elements/${sourceRef}``',
    paths: ['/program-elements/:param'],
  },
};

/** Find `${appBaseUrl()}${someExpr}` — an app URL whose path is not a literal. */
export function extractDynamicCtas(file: string, source: string): FoundCta[] {
  const found: FoundCta[] = [];
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\$\{(?:appBaseUrl\(\)|base)\}(\$\{[^}]*\})/g)) {
      found.push({ file, line: i + 1, path: m[1] ?? '', raw: m[0] ?? '' });
    }
  });
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function collectCtas(extractor: (f: string, s: string) => FoundCta[]): FoundCta[] {
  const all: FoundCta[] = [];
  for (const dir of CTA_SOURCE_DIRS) {
    for (const file of walk(dir)) {
      all.push(...extractor(file.replace(REPO_ROOT, '').replace(/\\/g, '/'), readFileSync(file, 'utf8')));
    }
  }
  return all;
}

const collectAllCtas = () => collectCtas(extractCtas);
const collectAllDynamicCtas = () => collectCtas(extractDynamicCtas);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractRoutePaths', () => {
  test('reads the real App.tsx and finds the LegiWatch route', () => {
    const paths = extractRoutePaths(readFileSync(APP_TSX, 'utf8'));
    expect(paths).toContain('/legiwatch');
    expect(paths).toContain('/clients');
    // RB-03's regression guard: the route that never existed must still not exist.
    expect(paths).not.toContain('/clients/:id');
    expect(paths).not.toContain('/clients/:clientId');
  });
});

describe('routeMatcher', () => {
  test('matches literal, param and splat routes', () => {
    expect(routeMatcher('/legiwatch').test('/legiwatch')).toBe(true);
    expect(routeMatcher('/legiwatch').test('/legiwatch/extra')).toBe(false);
    expect(routeMatcher('/program-elements/:peCode').test('/program-elements/0604770D8Z')).toBe(true);
    expect(routeMatcher('/engagement/*').test('/engagement/outreach/new')).toBe(true);
  });

  test('a trailing slash is the same route', () => {
    expect(routeMatcher('/clients').test('/clients/')).toBe(true);
  });
});

describe('extractCtas', () => {
  test('pulls the path out of an interpolated CTA and drops the query string', () => {
    const src = 'const u = `${appBaseUrl()}/legiwatch?tab=feed&client=${encodeURIComponent(id)}`;';
    expect(extractCtas('f.ts', src)[0]?.path).toBe('/legiwatch');
  });

  test('a parameterised final segment becomes a route param', () => {
    const src = 'const u = `${appBaseUrl()}/program-elements/${encodeURIComponent(code)}`;';
    expect(extractCtas('f.ts', src)[0]?.path).toBe('/program-elements/:param');
  });

  test('ignores non-path uses of ${base}', () => {
    // apps/api uses `base` for slugs and OAuth redirects; those are not CTAs.
    expect(extractCtas('f.ts', 'const s = `${base}-${i + 1}`;')).toEqual([]);
    expect(extractCtas('f.ts', 'const s = `${base}?provider=mcp`;')).toEqual([]);
  });
});

describe('every email CTA resolves to a real SPA route (V-5)', () => {
  const routes = buildResolvableRoutes(extractRoutePaths(readFileSync(APP_TSX, 'utf8')));
  const matchers = routes.map(routeMatcher);
  const ctas = collectAllCtas();

  test('the sweep actually found the known CTAs — a silent zero would pass vacuously', () => {
    // If a refactor renames appBaseUrl(), this test fails LOUDLY rather than
    // the suite quietly validating an empty set and reporting green.
    expect(ctas.length).toBeGreaterThanOrEqual(4);
    const files = new Set(ctas.map((c) => c.file));
    // Both rails must be represented.
    expect([...files].some((f) => f.includes('apps/intel-api'))).toBe(true);
    expect([...files].some((f) => f.includes('apps/api/src/tracker'))).toBe(true);
  });

  // Deduplicate by path so the report is about routes, not repetition.
  const uniqueCtas: [string, FoundCta][] = [...new Map(collectAllCtas().map((c) => [c.path, c])).values()].map(
    (c) => [c.path, c],
  );

  test.each(uniqueCtas)('%s resolves', (path: string, cta: FoundCta) => {
    const ok = matchers.some((m) => m.test(path));
    expect(ok ? '' : `${path} (${cta.file}:${cta.line}) matches no route in apps/web/src/App.tsx`).toBe('');
  });

  test('every VARIABLE-path CTA is declared in DYNAMIC_CTA_SOURCES', () => {
    // Without this, `${appBaseUrl()}${somethingNew}` would be invisible to the
    // sweep above and ship unverified — exactly the RB-03 failure mode.
    const undeclared = collectAllDynamicCtas()
      .filter((c) => !DYNAMIC_CTA_SOURCES[c.path])
      .map((c) => `${c.raw} at ${c.file}:${c.line}`);
    expect(undeclared).toEqual([]);
  });

  const dynamicPairs: [string, string][] = Object.entries(DYNAMIC_CTA_SOURCES).flatMap(([expr, d]) =>
    d.paths.map((p): [string, string] => [expr, p]),
  );

  test.each(dynamicPairs)('dynamic CTA %s can only produce %s, which resolves', (expr: string, path: string) => {
    const ok = matchers.some((m) => m.test(path));
    expect(ok ? '' : `${path} (from ${expr}, ${DYNAMIC_CTA_SOURCES[expr]?.producedBy}) matches no SPA route`).toBe('');
  });

  test('the declared dynamic CTAs are actually present in source', () => {
    // A stale allowlist entry is as bad as a missing one: it implies coverage
    // that no longer exists. Every declared expression must still be found.
    const seen = new Set(collectAllDynamicCtas().map((c) => c.path));
    expect([...Object.keys(DYNAMIC_CTA_SOURCES)].filter((k) => !seen.has(k))).toEqual([]);
  });
});
