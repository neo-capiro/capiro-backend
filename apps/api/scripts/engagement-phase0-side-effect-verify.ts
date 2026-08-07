#!/usr/bin/env node
/**
 * engagement-phase0-side-effect-verify.ts - Static verifier for side-effect registry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const API_ROOT = path.resolve(__dirname, '..', '..', '..'); // repo root — sourceFile paths are apps/api/...
const API_SRC = path.join(API_ROOT, 'apps', 'api', 'src');
const FIXTURE = path.join(API_SRC, 'engagement/__fixtures__/engagement-side-effect-registry.v1.json');

function parseFile(fp: string): ts.SourceFile|null {
  try { return ts.createSourceFile(fp, fs.readFileSync(fp,'utf-8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS); }
  catch { return null; }
}

function findEngagementFiles(): string[] {
  const d = path.join(API_SRC, 'engagement');
  const out: string[] = [];
  function w(dir: string) {
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()&&e.name!=='__fixtures__'&&e.name!=='__snapshots__') w(fp);
      else if (e.isFile()&&(e.name.endsWith('.ts')||e.name.endsWith('.tsx'))) out.push(fp);
    }
  }
  w(d);
  return out;
}

function findOnModuleInitClasses(): {sourceFile:string;symbol:string}[] {
  const out: {sourceFile:string;symbol:string}[] = [];
  for (const fp of findEngagementFiles()) {
    const sf = parseFile(fp); if (!sf) continue;
    function v(n: ts.Node) {
      if (ts.isClassDeclaration(n) && n.name) {
        if (n.heritageClauses) {
          for (const c of n.heritageClauses) {
            for (const t of c.types) {
              if (t.getText(sf)==='OnModuleInit') {
                out.push({ sourceFile: path.relative(API_ROOT, fp).replace(/\\/g,'/'), symbol: n.name.text });
              }
            }
          }
        }
        // Check for setInterval
        let hasSetInterval = false;
        function vb(n2: ts.Node) {
          if (ts.isCallExpression(n2)) {
            const e = n2.expression;
            if ((ts.isIdentifier(e) && e.text==='setInterval') || (ts.isPropertyAccessExpression(e) && e.name.text==='setInterval')) {
              hasSetInterval = true;
            }
          }
          ts.forEachChild(n2, vb);
        }
        ts.forEachChild(n, vb);
        if (hasSetInterval && !out.some(o=>o.symbol===n.name!.text)) {
          out.push({ sourceFile: path.relative(API_ROOT, fp).replace(/\\/g,'/'), symbol: n.name!.text });
        }
      }
      ts.forEachChild(n, v);
    }
    v(sf);
  }
  return out;
}

function main() {
  if (!fs.existsSync(FIXTURE)) { console.error('ERROR: Registry not found: '+FIXTURE); process.exit(1); }
  const registry = JSON.parse(fs.readFileSync(FIXTURE,'utf-8'));
  const entries = registry.entries || [];

  // Check source files exist
  for (const e of entries) {
    const abs = path.resolve(API_ROOT, e.sourceFile);
    if (!fs.existsSync(abs)) { console.error(`FAIL: Source file not found: ${e.id}: ${e.sourceFile}`); process.exit(1); }
  }

  // Check symbols exist
  for (const e of entries) {
    const abs = path.resolve(API_ROOT, e.sourceFile);
    const sf = parseFile(abs);
    if (!sf) { console.error(`FAIL: Cannot parse: ${e.id}: ${e.sourceFile}`); process.exit(1); }
    let found = false;
    function vs(n: ts.Node) { if(found)return; if(ts.isClassDeclaration(n)&&n.name?.text===e.symbol) found=true; if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text===e.symbol) found=true; ts.forEachChild(n,vs); }
    vs(sf);
    if (!found) { console.error(`FAIL: Symbol not found: ${e.id}: ${e.symbol} in ${e.sourceFile}`); process.exit(1); }
  }

  // Find unregistered OnModuleInit/timer classes
  const found = findOnModuleInitClasses();
  const registered = new Set(entries.map((e:any)=>e.symbol));
  const unregistered = found.filter(f=>!registered.has(f.symbol));
  if (unregistered.length > 0) {
    console.error('FAIL: Unregistered process loops:');
    for (const u of unregistered) console.error(`  - ${u.symbol} in ${u.sourceFile}`);
    process.exit(1);
  }

  // Check for secrets
  for (const e of entries) {
    const s = JSON.stringify(e).toLowerCase();
    if (s.includes('"api_key"')||s.includes('"secret"')||s.includes('"token"')||s.includes('"password"')) {
      console.error(`FAIL: Potential secret in ${e.id}`);
      process.exit(1);
    }
  }

  console.log('PASS: Side-effect registry verification');
  console.log(`  Registry entries: ${entries.length}`);
  console.log(`  Process loops found: ${found.length}`);
  console.log(`  Unregistered: ${unregistered.length}`);
}

main();
