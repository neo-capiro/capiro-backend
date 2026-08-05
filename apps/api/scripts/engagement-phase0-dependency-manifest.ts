#!/usr/bin/env node
/**
 * engagement-phase0-dependency-manifest.ts — Phase 0 Workstream C
 * Scans all .ts files for imports into engagement/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const API_ROOT = path.resolve(__dirname, '..');
const API_SRC = path.join(API_ROOT, 'src');
const ENGAGEMENT_DIR = 'engagement/';

interface DepEntry {
  importerFile: string; importedFile: string; importedSymbols: string[];
  importKind: 'value'|'type-only'|'dynamic'|'side-effect';
  isExternal: boolean;
  category: 'root_registration'|'reviews'|'meri'|'intelligence_deliverable'|'webhook'|'context'|'memory'|'other';
}

function isEngagementPath(p: string): boolean {
  return p.replace(/\\/g,'/').includes('/engagement/')||p.includes('engagement/');
}
function repoRel(abs: string): string {
  const n = abs.replace(/\\/g,'/');
  const i = n.indexOf('apps/api/src/');
  return i>=0 ? n.substring(i) : n;
}
function isInsideEngagement(rp: string): boolean {
  return rp.replace(/\\/g,'/').includes('/engagement/');
}
function classify(rp: string): DepEntry['category'] {
  const p = rp.toLowerCase();
  if (p.includes('/app.module')||p.includes('/main.')) return 'root_registration';
  if (p.includes('/reviews/')) return 'reviews';
  if (p.includes('/meri/')) return 'meri';
  if (p.includes('/intelligence/')||p.includes('alert-memo')||p.includes('district-brief')) return 'intelligence_deliverable';
  if (p.includes('/webhooks/')) return 'webhook';
  if (p.includes('/context/')) return 'context';
  if (p.includes('/memory/')) return 'memory';
  return 'other';
}

function parseFile(fp: string): ts.SourceFile|null {
  try { return ts.createSourceFile(fp, fs.readFileSync(fp,'utf-8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS); }
  catch { return null; }
}

function extractImports(sf: ts.SourceFile): { specifier:string; symbols:string[]; kind:DepEntry['importKind'] }[] {
  const out: { specifier:string; symbols:string[]; kind:DepEntry['importKind'] }[] = [];
  function v(n: ts.Node) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const syms: string[] = [];
      if (n.importClause) {
        if (n.importClause.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
          for (const e of n.importClause.namedBindings.elements) syms.push(e.name.text);
        } else if (n.importClause.namedBindings && ts.isNamespaceImport(n.importClause.namedBindings)) {
          syms.push(n.importClause.namedBindings.name.text);
        }
        if (n.importClause.name) syms.push(n.importClause.name.text);
        out.push({ specifier: spec, symbols: syms, kind: n.importClause.isTypeOnly ? 'type-only' : 'value' });
      } else { out.push({ specifier: spec, symbols: [], kind: 'side-effect' }); }
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments.length>0 && ts.isStringLiteral(n.arguments[0])) {
      out.push({ specifier: n.arguments[0].text, symbols: [], kind: 'dynamic' });
    }
    ts.forEachChild(n, v);
  }
  v(sf);
  return out;
}

function resolveRel(importerDir: string, spec: string): string|null {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(importerDir, spec);
  const r = repoRel(abs);
  if (!r.includes(ENGAGEMENT_DIR) && !r.includes('engagement/')) return null;
  // Try to find actual file
  const candidates = [r, r+'.ts', r+'.tsx', path.join(r,'index.ts'), path.join(r,'index.tsx')];
  for (const c of candidates) {
    const a = path.join(API_ROOT, '..'); // apps/api
    if (fs.existsSync(path.join(a, c.replace('apps/api/','')))) return c;
  }
  return r; // unresolved but recorded
}

function scan() {
  const ext: DepEntry[] = [], int: DepEntry[] = [];
  function walk(dir: string) {
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory() && e.name!=='node_modules' && e.name!=='__snapshots__') walk(fp);
      else if (e.isFile() && (e.name.endsWith('.ts')||e.name.endsWith('.tsx'))) {
        const sf = parseFile(fp); if (!sf) return;
        const imports = extractImports(sf);
        for (const imp of imports) {
          const resolved = resolveRel(path.dirname(fp), imp.specifier);
          if (!resolved) continue;
          const importerRel = repoRel(fp);
          const isExt = !isInsideEngagement(importerRel);
          const entry: DepEntry = {
            importerFile: importerRel, importedFile: resolved, importedSymbols: imp.symbols,
            importKind: imp.kind, isExternal: isExt, category: classify(importerRel),
          };
          (isExt ? ext : int).push(entry);
        }
      }
    }
  }
  walk(API_SRC);
  const sortFn = (a:DepEntry,b:DepEntry)=>a.importerFile.localeCompare(b.importerFile)||a.importedFile.localeCompare(b.importedFile);
  ext.sort(sortFn); int.sort(sortFn);
  // dedupe
  const dedupe = (arr: DepEntry[]) => {
    const seen = new Set<string>();
    return arr.filter(e=>{const k=`${e.importerFile}|${e.importedFile}|${e.importedSymbols.join(',')}|${e.importKind}`; if(seen.has(k))return false; seen.add(k); return true;});
  };
  return { external: dedupe(ext), internal: dedupe(int) };
}

function main() {
  const write = process.argv.includes('--write');
  const { external, internal } = scan();
  const manifest = {
    schemaVersion: 1, externalImporters: external, internalImports: internal,
    summary: { externalImporterCount: external.length, importedSymbolCount: external.reduce((s,e)=>s+e.importedSymbols.length,0) },
  };
  const out = JSON.stringify(manifest, null, 2) + '\n';
  if (write) {
    const fp = path.join(API_ROOT, 'src/engagement/__fixtures__/engagement-dependency-manifest.v1.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, out);
    console.log(`Wrote ${external.length} external importers to ${fp}`);
  } else { process.stdout.write(out); }
}
main();
