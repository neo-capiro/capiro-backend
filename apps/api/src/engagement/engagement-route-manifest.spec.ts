import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'engagement-route-manifest.v1.json');
const SCRIPT = path.join(REPO, 'apps', 'api', 'scripts', 'engagement-phase0-route-manifest.ts');
const TSX = path.join(REPO, 'apps', 'api', 'node_modules', '.bin', 'tsx');

function readFixture() { return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')); }
function generate() { return JSON.parse(execSync(`bash "${TSX}" "${SCRIPT}"`, {cwd:REPO,stdio:'pipe',timeout:30000}).toString()); }

describe('Engagement route manifest', () => {
  describe('fixture integrity', () => {
    it('exists and parses', () => { const m = readFixture(); expect(m.schemaVersion).toBe(1); expect(Array.isArray(m.routes)).toBe(true); expect(m.routes.length).toBeGreaterThan(0); });
    it('global prefix is /api', () => { expect(readFixture().globalPrefix).toBe('/api'); });
    it('generatedAt is null', () => { expect(readFixture().generatedAt).toBeNull(); });
  });
  describe('route invariants', () => {
    let routes: any[];
    beforeAll(() => { routes = readFixture().routes; });
    it('no duplicate (method, path) pairs', () => { const s=new Map<string,string>(),d:string[]=[]; for(const r of routes){const k=`${r.method} ${r.path}`; if(s.has(k)) d.push(`${k}: ${s.get(k)} vs ${r.controller}.${r.handler}`); s.set(k,`${r.controller}.${r.handler}`);} expect(d).toEqual([]); });
    it('nonempty controller and handler', () => { for(const r of routes){expect(r.controller).toBeTruthy(); expect(r.handler).toBeTruthy();} });
    it('recognized classification', () => { const v=['read','write','generation','external_send','oauth','webhook','internal_secret','sync','notetaker','attachment']; for(const r of routes) expect(v).toContain(r.classification); });
    it('mutating routes are not read', () => { for(const r of routes) if(['POST','PUT','PATCH','DELETE'].includes(r.method)) expect(r.classification).not.toBe('read'); });
    it('/webhooks/recall not prefixed /api', () => { const rec=routes.filter((r:any)=>r.path.startsWith('/webhooks/recall')); expect(rec.length).toBeGreaterThan(0); for(const r of rec) expect(r.path).not.toMatch(/^\/api\/webhooks/); });
    it('OAuth callbacks present', () => { expect(routes.filter((r:any)=>r.path.includes('callback')&&r.controller.includes('OAuth')).length).toBeGreaterThan(0); });
    it('internal AI credential is internal_secret', () => { const i=routes.filter((r:any)=>r.path.includes('internal/ai-credentials')); expect(i.length).toBeGreaterThan(0); for(const r of i) expect(r.classification).toBe('internal_secret'); });
    it('sorted deterministically (by path, then method)', () => { const p=routes.map((r:any)=>r.path); for(let i=1;i<p.length;i++){const cmp=p[i].localeCompare(p[i-1]); if(cmp<0){fail(`Paths not sorted at index ${i}: ${p[i-1]} > ${p[i]}`);return;} if(cmp===0){const mcmp=routes[i].method.localeCompare(routes[i-1].method); if(mcmp<0){fail(`Methods not sorted at index ${i}: ${routes[i-1].path} ${routes[i-1].method} > ${routes[i].method}`);}}} });
    it('all required controllers represented', () => { const c=new Set(routes.map((r:any)=>r.controller)); for(const n of ['EngagementController','MicrosoftOAuthController','GoogleOAuthController','OutcomeController','InternalAiCredentialsController','RecallWebhookController']) expect(c.has(n)).toBe(true); });
  });
  describe('snapshot comparison', () => {
    it('regenerated matches committed', () => { const c=readFixture(),g=generate(); delete c.generatedAt; delete g.generatedAt; expect(g).toEqual(c); });
  });
  describe('negative controls', () => {
    it('synthetic route change causes mismatch', () => { const c=readFixture(),d=JSON.parse(JSON.stringify(c)); if(d.routes.length>0) d.routes[0].path='/api/engagement/NONEXISTENT'; expect(d).not.toEqual(c); });
  });
});
