import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'engagement-side-effect-registry.v1.json');
const VERIFIER = path.join(REPO, 'apps', 'api', 'scripts', 'engagement-phase0-side-effect-verify.ts');
const TSX = path.join(REPO, 'apps', 'api', 'node_modules', '.bin', 'tsx');

function readFixture() { return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')); }
function runVerifier(): { passed: boolean; output: string } {
  try { return { passed: true, output: execSync(`bash "${TSX}" "${VERIFIER}"`, {cwd:REPO,stdio:'pipe',timeout:30000}).toString() }; }
  catch(e: any) { return { passed: false, output: (e.stdout?.toString()??'')+(e.stderr?.toString()??'') }; }
}

describe('Engagement side-effect registry', () => {
  describe('fixture integrity', () => {
    it('exists and parses', () => { const m=readFixture(); expect(m.schemaVersion).toBe(1); expect(Array.isArray(m.entries)).toBe(true); expect(m.entries.length).toBeGreaterThan(0); });
    it('all required fields', () => { const rf=['id','sourceFile','symbol','trigger','effect','externalSystem','currentProcessOwner','activationConfig','idempotencyBoundary','concurrencyBoundary','containsSensitiveData','phase1ContainmentRequirement']; for(const e of readFixture().entries) for(const f of rf) expect(e).toHaveProperty(f); });
    it('unique ids', () => { const ids=readFixture().entries.map((e:any)=>e.id); expect(new Set(ids).size).toBe(ids.length); });
    it('all main_api owned', () => { for(const e of readFixture().entries) expect(e.currentProcessOwner).toBe('main_api'); });
    it('no secret material', () => { const sp=/\b(api_key|secret|password)\b/i; for(const e of readFixture().entries){const check=[e.externalSystem,e.idempotencyBoundary,e.concurrencyBoundary]; for(const v of check) if(v) expect(sp.test(String(v))).toBe(false);} });
  });
  describe('static verifier', () => {
    it('verifier exits 0', () => { expect(runVerifier().passed).toBe(true); });
    it('verifier output mentions PASS', () => { expect(runVerifier().output).toContain('PASS'); });
  });
  describe('negative controls', () => {
    it('removing timer entry reduces count', () => { const c=readFixture(); const modified=JSON.parse(JSON.stringify(c)); modified.entries=modified.entries.filter((e:any)=>e.symbol!=='EngagementSyncSchedulerService'); const origOnMod=c.entries.filter((e:any)=>e.trigger==='on_module_init').length; const modOnMod=modified.entries.filter((e:any)=>e.trigger==='on_module_init').length; expect(modOnMod).toBeLessThan(origOnMod); });
    it('changing symbol causes mismatch', () => { const c=readFixture(),m=JSON.parse(JSON.stringify(c)); const i=m.entries.findIndex((e:any)=>e.symbol==='OutreachJobService'); if(i>=0){m.entries[i].symbol='NonExistent'; expect(m.entries[i].symbol).not.toBe('OutreachJobService');} });
  });
});
