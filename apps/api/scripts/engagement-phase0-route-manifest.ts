/**
 * engagement-phase0-route-manifest.ts
 * Parses Engagement controllers via TS compiler API, emits deterministic JSON manifest.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const API_ROOT = path.resolve(__dirname, '..');

interface RouteEntry {
  method: string; path: string; controller: string; handler: string;
  sourceFile: string; sourceLine: number;
  controllerGuards: string[]; handlerGuards: string[];
  controllerRoles: string[]; handlerRoles: string[];
  throttle: string | null; httpCode: number | null;
  bodyDto: string | null; queryDto: string | null;
  parameterNames: string[];
  classification: 'read'|'write'|'generation'|'external_send'|'oauth'|'webhook'|'internal_secret'|'sync'|'notetaker'|'attachment';
}

interface ControllerDef {
  absolutePath: string; repoPath: string;
  controllerName: string; controllerPrefix: string; barePrefix: boolean;
}

function getDefs(): ControllerDef[] {
  return [
    { absolutePath: path.join(API_ROOT, 'src/engagement/engagement.controller.ts'), repoPath: 'apps/api/src/engagement/engagement.controller.ts', controllerName: 'EngagementController', controllerPrefix: 'engagement', barePrefix: false },
    { absolutePath: path.join(API_ROOT, 'src/engagement/microsoft/microsoft-oauth.controller.ts'), repoPath: 'apps/api/src/engagement/microsoft/microsoft-oauth.controller.ts', controllerName: 'MicrosoftOAuthController', controllerPrefix: 'engagement/integrations/microsoft', barePrefix: false },
    { absolutePath: path.join(API_ROOT, 'src/engagement/google/google-oauth.controller.ts'), repoPath: 'apps/api/src/engagement/google/google-oauth.controller.ts', controllerName: 'GoogleOAuthController', controllerPrefix: 'engagement/integrations/google', barePrefix: false },
    { absolutePath: path.join(API_ROOT, 'src/engagement/outcome/outcome.controller.ts'), repoPath: 'apps/api/src/engagement/outcome/outcome.controller.ts', controllerName: 'OutcomeController', controllerPrefix: 'engagement/outcomes', barePrefix: false },
    { absolutePath: path.join(API_ROOT, 'src/engagement/internal-ai-credentials.controller.ts'), repoPath: 'apps/api/src/engagement/internal-ai-credentials.controller.ts', controllerName: 'InternalAiCredentialsController', controllerPrefix: 'internal/ai-credentials', barePrefix: false },
    { absolutePath: path.join(API_ROOT, 'src/webhooks/recall-webhook.controller.ts'), repoPath: 'apps/api/src/webhooks/recall-webhook.controller.ts', controllerName: 'RecallWebhookController', controllerPrefix: 'webhooks/recall', barePrefix: true },
  ];
}

function parseSourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf-8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function getDecoratorName(d: ts.Decorator): string | null {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
}
function getDecoratorStringArg(d: ts.Decorator, sf: ts.SourceFile): string | null {
  const e = d.expression;
  if (ts.isCallExpression(e) && e.arguments.length > 0 && ts.isStringLiteral(e.arguments[0])) return e.arguments[0].text;
  return null;
}
function getDecoratorIdentArgs(d: ts.Decorator, sf: ts.SourceFile): string[] {
  const e = d.expression;
  if (ts.isCallExpression(e)) return e.arguments.map(a => {
    if (ts.isIdentifier(a)) return a.text;
    if (ts.isStringLiteral(a)) return a.text;
    if (ts.isPropertyAccessExpression(a)) return a.name.text;
    return null;
  }).filter((s): s is string => s !== null);
  return [];
}
function getDecoratorFirstArg(d: ts.Decorator, sf: ts.SourceFile): string | null {
  const e = d.expression;
  if (ts.isCallExpression(e) && e.arguments.length > 0) return e.arguments[0].getText(sf);
  return null;
}
function getLine(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function getParamNames(m: ts.MethodDeclaration, sf: ts.SourceFile): string[] {
  return m.parameters.map(p => p.name.getText(sf));
}
const HTTP_METHODS = new Set(['Get','Post','Put','Patch','Delete']);

function classify(method: string, fullPath: string, ctrl: string, handler: string): RouteEntry['classification'] {
  if (ctrl === 'RecallWebhookController') return 'webhook';
  if (fullPath.startsWith('/api/internal/')) return 'internal_secret';
  if (ctrl.includes('OAuth')) return 'oauth';
  if (fullPath.includes('notetaker') && handler !== 'getNotetaker') return 'notetaker';
  if (fullPath.includes('send')||handler.startsWith('send')||handler==='sendCampaign'||handler==='sendBatch') return 'external_send';
  if (fullPath.includes('generate')||handler.startsWith('generate')||fullPath.includes('draft-artifacts')||fullPath.includes('draft-versions')||handler==='generateDebriefDraft'||handler==='generateMeetingPrep') return 'generation';
  if (fullPath.includes('attachments')) return 'attachment';
  if (fullPath.includes('/sync')||handler.includes('sync')||handler==='syncConnection'||handler==='syncCalendarWindow'||handler==='configureSubscriptions') return 'sync';
  if (['POST','PUT','PATCH','DELETE'].includes(method)) return 'write';
  return 'read';
}

function parseAll(defs: ControllerDef[]) {
  const routes: RouteEntry[] = [];
  const errors: string[] = [];
  for (const def of defs) {
    if (!fs.existsSync(def.absolutePath)) { errors.push(`Missing: ${def.absolutePath}`); continue; }
    const sf = parseSourceFile(def.absolutePath);
    let cc: ts.ClassDeclaration|null = null;
    const cGuards: string[] = [], cRoles: string[] = [];
    function vc(n: ts.Node) {
      if (ts.isClassDeclaration(n) && n.name?.text === def.controllerName) {
        cc = n;
        for (const d of ts.getDecorators(n) ?? []) {
          const nm = getDecoratorName(d);
          if (nm === 'UseGuards') cGuards.push(...getDecoratorIdentArgs(d, sf));
          if (nm === 'Roles') cRoles.push(...getDecoratorIdentArgs(d, sf));
        }
      }
      ts.forEachChild(n, vc);
    }
    vc(sf);
    if (!cc) { errors.push(`Class ${def.controllerName} not found in ${def.absolutePath}`); continue; }
    for (const m of cc.members) {
      if (!ts.isMethodDeclaration(m) || !m.name) continue;
      const decs = ts.getDecorators(m); if (!decs) continue;
      const hGuards: string[] = [], hRoles: string[] = [];
      let throttle: string|null=null, httpCode: number|null=null, mn: string|null=null, mpa: string|null=null, bd: string|null=null, qd: string|null=null;
      for (const d of decs) {
        const nm = getDecoratorName(d);
        if (nm==='UseGuards') hGuards.push(...getDecoratorIdentArgs(d,sf));
        else if (nm==='Roles') hRoles.push(...getDecoratorIdentArgs(d,sf));
        else if (nm==='Throttle') throttle=getDecoratorFirstArg(d,sf);
        else if (nm==='HttpCode') { const t=getDecoratorFirstArg(d,sf); if(t) httpCode=Number(t); }
        else if (HTTP_METHODS.has(nm??'')) { mn=nm; mpa=getDecoratorStringArg(d,sf); }
      }
      if (!mn) continue;
      for (const p of m.parameters) {
        for (const pd of ts.getDecorators(p)??[]) {
          const pn = getDecoratorName(pd);
          if (pn==='Body'&&p.type) bd=p.type.getText(sf);
          if (pn==='Query'&&p.type) qd=p.type.getText(sf);
        }
      }
      const params = getParamNames(m, sf);
      let fp = def.barePrefix ? '/'+def.controllerPrefix+(mpa?'/'+mpa:'') : '/api/'+def.controllerPrefix+(mpa?'/'+mpa:'');
      fp = '/'+fp.replace(/^\/+/,'').replace(/\/+/g,'/').replace(/\/$/,'');
      const handlerName = m.name.getText(sf);
      routes.push({
        method: mn.toUpperCase(), path: fp, controller: def.controllerName, handler: handlerName,
        sourceFile: def.repoPath, sourceLine: getLine(m, sf),
        controllerGuards: [...cGuards], handlerGuards: hGuards,
        controllerRoles: [...cRoles], handlerRoles: hRoles,
        throttle, httpCode, bodyDto: bd, queryDto: qd, parameterNames: params,
        classification: classify(mn.toUpperCase(), fp, def.controllerName, handlerName),
      });
    }
  }
  routes.sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method)||a.controller.localeCompare(b.controller)||a.handler.localeCompare(b.handler));
  const seen = new Map<string,string>();
  for (const r of routes) {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) errors.push(`Duplicate: ${k} (${r.controller}.${r.handler} vs ${seen.get(k)})`);
    seen.set(k, `${r.controller}.${r.handler}`);
  }
  return { routes, errors };
}

function main() {
  const write = process.argv.includes('--write');
  const defs = getDefs();
  const missing = defs.filter(d=>!fs.existsSync(d.absolutePath));
  if (missing.length) { console.error('ERROR: Missing sources:'); for(const d of missing) console.error(`  - ${d.repoPath}`); process.exit(1); }
  const { routes, errors } = parseAll(defs);
  if (errors.length) { console.error('ERROR: Parser errors:'); for(const e of errors) console.error(`  - ${e}`); process.exit(1); }
  const checks = [
    { d:'Recall webhook bare', f:(r:RouteEntry)=>r.path==='/webhooks/recall' },
    { d:'OAuth callback', f:(r:RouteEntry)=>r.path.includes('callback')&&r.controller.includes('OAuth') },
    { d:'Internal AI secret', f:(r:RouteEntry)=>r.path.includes('internal/ai-credentials')&&r.classification==='internal_secret' },
  ];
  for (const c of checks) { if (!routes.some(c.f)) { console.error(`ERROR: Required check failed: ${c.d}`); process.exit(1); } }
  const manifest = { schemaVersion: 1, generatedAt: null, globalPrefix: '/api', routes };
  const out = JSON.stringify(manifest, null, 2) + '\n';
  if (write) {
    const fp = path.join(API_ROOT, 'src/engagement/__fixtures__/engagement-route-manifest.v1.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, out);
    console.log(`Wrote ${routes.length} routes to ${fp}`);
  } else { process.stdout.write(out); }
}
main();
