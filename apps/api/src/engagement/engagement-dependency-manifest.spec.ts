import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'engagement-dependency-manifest.v1.json');
const SCRIPT = path.join(REPO, 'apps', 'api', 'scripts', 'engagement-phase0-dependency-manifest.ts');
const TSX = path.join(REPO, 'apps', 'api', 'node_modules', '.bin', 'tsx');

function readFixture() { return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')); }
function generate() { return JSON.parse(execSync(`bash "${TSX}" "${SCRIPT}"`, {cwd:REPO,stdio:'pipe',timeout:30000}).toString()); }

describe('Engagement dependency manifest', () => {
  describe('fixture integrity', () => {
    it('exists and parses', () => { const m=readFixture(); expect(m.schemaVersion).toBe(1); expect(Array.isArray(m.externalImporters)).toBe(true); });
    it('has root_registration category', () => { expect(new Set(readFixture().externalImporters.map((e:any)=>e.category)).has('root_registration')).toBe(true); });
  });
  describe('structural invariants', () => {
    let m: any;
    beforeAll(() => { m = readFixture(); });
    it('no duplicate entries', () => { const s=new Set<string>(),d:string[]=[]; for(const e of m.externalImporters){const k=`${e.importerFile}|${e.importedFile}|${e.importedSymbols.join(',')}|${e.importKind}`; if(s.has(k)) d.push(k); s.add(k);} expect(d).toEqual([]); });
    it('no self-import', () => { for(const e of m.externalImporters) expect(e.importerFile).not.toBe(e.importedFile); });
    it('isExternal boolean', () => { for(const e of [...m.externalImporters,...m.internalImports]) expect(typeof e.isExternal).toBe('boolean'); });
  });
  describe('snapshot comparison', () => {
    it('regenerated matches committed', () => { expect(generate()).toEqual(readFixture()); });
  });
  describe('negative controls', () => {
    it('synthetic change causes mismatch', () => { const c=readFixture(),d=JSON.parse(JSON.stringify(c)); if(d.externalImporters.length>0) d.externalImporters[0].importedSymbols=['SYNTHETIC']; expect(d).not.toEqual(c); });
  });
});
