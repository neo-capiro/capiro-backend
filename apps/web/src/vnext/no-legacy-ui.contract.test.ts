import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No-legacy-UI contract for the vNext surface (owner directive, 2026-08-18:
 * os.capiro.ai ships ONLY the vNext / Untitled UI design system).
 *
 * Because both surfaces compile into one bundle (WEB_SURFACE branches at
 * runtime — see App.tsx/BillingGate), any RUNTIME import chain from
 * `src/vnext/**` that reaches the `antd`/`@ant-design` packages, or a CSS
 * file living outside `src/vnext`, ships old UI to os.capiro.ai. This test
 * walks every module under `src/vnext`, follows relative imports through the
 * legacy tree, and fails on any such edge.
 *
 * Type-only imports (`import type ... from`) are erased by tsc and are fine.
 * Inline dynamic-import type annotations are NOT fine even though tsc erases
 * them too — this checker cannot see type positions, so normalize them to a
 * top-level `import type` (see pages/program-element/api.ts for the pattern
 * and the comment-canary trap).
 *
 * The allowlist below is the set of DELIBERATE exceptions, each tracked to a
 * removal plan. Shrink it; never grow it without an owner decision. A stale
 * entry (edge no longer present) also fails, so the list cannot rot.
 */

/** vnext file -> legacy modules it may reach at runtime (Phase 3 backlog). */
const ALLOWED_LEGACY_EDGES: Record<string, string[]> = {
  // Program Elements Phase 3: the workspace (Explore · Movement ·
  // Congressional · Actions · Portfolio) and both static segments are native
  // now (PE-CORE). The remaining sanctioned antd reaches are the three lazy
  // page mounts below, each owned by a named sibling swap:
  'vnext/pages/program-elements/VNextProgramElementsRoutes.tsx': [
    // TEMP: PE-FALLBACK swap pending — non-internal tenants' read surfaces
    // (finder + watch). The PE-FALLBACK agent swaps them and deletes both.
    'pages/program-element/ProgramElementFinderPage.tsx',
    'pages/program-element/ProgramElementWatchPage.tsx',
  ],
};

const SRC_ROOT = resolve(process.cwd(), 'src');
const VNEXT_ROOT = join(SRC_ROOT, 'vnext');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
  }
}

/** Strip type-only import/export statements — erased at runtime. */
function stripTypeOnly(src: string): string {
  return src
    .replace(/import\s+type\s[\s\S]*?from\s*['"][^'"]+['"];?/g, '')
    .replace(/export\s+type\s[\s\S]*?from\s*['"][^'"]+['"];?/g, '');
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare package specifier
  let base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const ext of ['.tsx', '.ts', '.jsx', '.js', `${sep}index.tsx`, `${sep}index.ts`]) {
    const cand = base + ext;
    if (existsSync(cand)) return cand;
  }
  if (existsSync(base) && statSync(base).isFile()) return base;
  return null;
}

function isVNextPath(p: string): boolean {
  return p.includes(`${sep}vnext${sep}`);
}

function rel(p: string): string {
  return relative(SRC_ROOT, p).split(sep).join('/');
}

interface LegacyReach {
  antd: boolean;
  css: string[];
}

const reachCache = new Map<string, LegacyReach>();

/** Does this legacy module transitively reach antd or non-vnext CSS at runtime? */
function analyzeLegacy(file: string, stack = new Set<string>()): LegacyReach {
  const cached = reachCache.get(file);
  if (cached) return cached;
  if (stack.has(file)) return { antd: false, css: [] };
  stack.add(file);
  const src = stripTypeOnly(readFileSync(file, 'utf8'));
  let antd =
    /from\s*['"](antd|@ant-design)/.test(src) || /import\s*['"](antd|@ant-design)/.test(src);
  const css: string[] = [];
  for (const m of src.matchAll(/import\s*\(?\s*['"]([^'"]+\.css)['"]/g)) {
    const spec = m[1];
    if (!spec) continue;
    const resolved = resolve(dirname(file), spec);
    if (!isVNextPath(resolved)) css.push(rel(resolved));
  }
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec) continue;
    const target = resolveImport(file, spec);
    if (!target || isVNextPath(target) || target === file || /\.css$/.test(target)) continue;
    const sub = analyzeLegacy(target, stack);
    antd = antd || sub.antd;
    for (const c of sub.css) if (!css.includes(c)) css.push(c);
  }
  stack.delete(file);
  const result = { antd, css };
  reachCache.set(file, result);
  return result;
}

interface Finding {
  vnextFile: string;
  legacyModule: string;
  reason: string;
}

function collectFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const file of walk(VNEXT_ROOT)) {
    if (/\.test\.(tsx?|jsx?)$/.test(file)) continue; // tests may import legacy fixtures
    const src = stripTypeOnly(readFileSync(file, 'utf8'));
    if (/from\s*['"](antd|@ant-design)/.test(src)) {
      findings.push({
        vnextFile: rel(file),
        legacyModule: '(direct antd import)',
        reason: 'imports antd directly',
      });
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec) continue;
      const target = resolveImport(file, spec);
      if (!target || isVNextPath(target)) continue;
      if (/\.css$/.test(target)) {
        findings.push({
          vnextFile: rel(file),
          legacyModule: rel(target),
          reason: 'imports a legacy stylesheet',
        });
        continue;
      }
      const reach = analyzeLegacy(target);
      if (reach.antd || reach.css.length) {
        findings.push({
          vnextFile: rel(file),
          legacyModule: rel(target),
          reason: [
            reach.antd ? 'reaches antd' : null,
            reach.css.length ? `pulls legacy CSS: ${reach.css.slice(0, 3).join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('; '),
        });
      }
    }
  }
  return findings;
}

describe('vNext no-legacy-UI contract', () => {
  const findings = collectFindings();

  it('no vNext module reaches antd or legacy CSS at runtime (outside the sanctioned Phase 2 allowlist)', () => {
    const violations = findings.filter(
      (f) => !(ALLOWED_LEGACY_EDGES[f.vnextFile] ?? []).includes(f.legacyModule),
    );
    expect(
      violations.map((f) => `${f.vnextFile} -> ${f.legacyModule} (${f.reason})`),
    ).toEqual([]);
  });

  it('the allowlist carries no stale entries — delete each edge as its Phase 2 port lands', () => {
    const present = new Set(findings.map((f) => `${f.vnextFile} -> ${f.legacyModule}`));
    const stale = Object.entries(ALLOWED_LEGACY_EDGES)
      .flatMap(([vnextFile, legacyModules]) =>
        legacyModules.map((legacyModule) => `${vnextFile} -> ${legacyModule}`),
      )
      .filter((edge) => !present.has(edge));
    expect(stale).toEqual([]);
  });
});
