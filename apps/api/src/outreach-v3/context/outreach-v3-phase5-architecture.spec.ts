import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'src/outreach-v3'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const API_ROOT = apiRoot();
const REPO_ROOT = resolve(API_ROOT, '../..');
const readApi = (path: string) => readFileSync(resolve(API_ROOT, path), 'utf8');

function productionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) out.push(...productionFiles(path));
    else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.spec.tsx') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      out.push(path);
    }
  }
  return out;
}

function controllerRoutes(source: string) {
  const prefix = source.match(/@Controller\('([^']+)'\)/)?.[1];
  if (!prefix) throw new Error('controller prefix not found');
  const routes: Array<{ method: string; path: string; handler: string }> = [];
  const regex = /@(Get|Post)\('([^']+)'\)\s+([A-Za-z0-9_]+)\s*\(/g;
  for (const match of source.matchAll(regex)) {
    routes.push({
      method: match[1]!.toUpperCase(),
      path: `/api/${prefix}/${match[2]}`.replace(/\/+/g, '/'),
      handler: match[3]!,
    });
  }
  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

describe('Outreach V3 Revised Phase 5 architecture', () => {
  it('freezes the exact dark context route contract', () => {
    const controller = readApi('src/outreach-v3/context/outreach-v3-context.controller.ts');
    const manifest = JSON.parse(
      readApi('src/outreach-v3/__fixtures__/outreach-v3-context-route-manifest.v1.json'),
    ) as {
      runtime: string;
      requiresStateFlag: string;
      featureFlag: string;
      disabledBehavior: number;
      routes: Array<{ method: string; path: string; handler: string }>;
    };
    expect(controllerRoutes(controller)).toEqual(
      [...manifest.routes].sort((a, b) =>
        `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
      ),
    );
    expect(manifest).toMatchObject({
      runtime: 'engagement-api',
      requiresStateFlag: 'OUTREACH_V3_STATE_ENABLED',
      featureFlag: 'OUTREACH_V3_CONTEXT_ENABLED',
      disabledBehavior: 404,
    });
  });

  it('mounts context intelligence only in the existing engagement-api runtime', () => {
    const engagement = readApi('src/engagement-api.app.module.ts');
    const main = readApi('src/app.module.ts');
    expect(engagement).toContain('OutreachV3ContextModule');
    expect(main).not.toContain('OutreachV3ContextModule');
    expect(main).not.toContain('outreach-v3/context');
  });

  it('implements governed context commands but leaves generation and send future-owned', () => {
    const commands = readApi('src/outreach-v3/state/outreach-command.contract.ts');
    const registry = readApi('src/outreach-v3/commands/outreach-command-registry.ts');
    for (const implemented of ['ACCEPT_CONTEXT_REFS', 'EXCLUDE_CONTEXT_REFS']) {
      expect(commands).toContain(`'${implemented}'`);
      expect(registry).toContain(`'${implemented}'`);
    }
    for (const future of [
      'SET_SENDER_REF',
      'SET_ATTACHMENT_REFS',
      'REQUEST_SAMPLE_GENERATION',
      'REQUEST_FULL_GENERATION',
      'REQUEST_SEND_REVIEW',
    ]) {
      expect(commands).toContain(`'${future}'`);
    }
  });

  it('keeps context resolution server-side and the reducer side-effect free', () => {
    const engine = readApi('src/outreach-v3/services/outreach-command-engine.service.ts');
    const reducer = readApi('src/outreach-v3/state/outreach-command-reducer.ts');
    expect(engine).toContain('contextReferences.resolveManyWithinTx');
    expect(engine).toContain('contextReferences.reauthorizeSnapshotsWithinTx');
    expect(engine).toContain('assertOutreachContextSponsorIsolation');
    expect(reducer).toContain('resolvedContextRefs');
    expect(reducer).not.toMatch(/PrismaService|CapabilityRegistry|fetch\(|axios|OpenAI/);
  });

  it('makes null client context tenant-neutral rather than a wildcard', () => {
    const memory = readApi('src/capabilities/context/search-memory.capability.ts');
    const references = readApi('src/capabilities/context/outreach-context-reference.service.ts');
    expect(memory).toContain('AND client_id IS NULL');
    expect(references).toContain('row.client_id !== locator.clientId');
    expect(references).toContain('row.clientId !== locator.clientId');
  });

  it('preserves private meeting visibility for attachment-derived context', () => {
    const references = readApi('src/capabilities/context/outreach-context-reference.service.ts');
    expect(references).toContain("visibility: 'shared'");
    expect(references).toContain('createdByUserId: ctx.userId');
    expect(references).toContain('if (!visibleMeeting) throw contextNotFound()');
  });

  it('lets reasoning discover context and strategy but never apply or send', () => {
    const reasoningRoot = resolve(API_ROOT, 'src/outreach-v3/reasoning');
    const source = productionFiles(reasoningRoot)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const tool of [
      'search_memory',
      'research_government',
      'get_document',
      'recommend_outreach_strategy',
    ]) {
      expect(source).toContain(tool);
    }
    expect(source).toContain('createModelProposalWithinTx');
    expect(source).not.toContain('OutreachCommandEngineService');
    expect(source).not.toContain('.applyProposal(');
    expect(source).not.toContain('.applyBatch(');
    expect(source).not.toContain('SEND_EMAIL_NOW');
  });

  it('does not implement final Outreach UI, another runtime, LangGraph, or LangSmith', () => {
    const webRoot = resolve(REPO_ROOT, 'apps/web/src');
    const webSource = productionFiles(webRoot)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(webSource).not.toContain('/outreach-v3/sessions/');
    expect(webSource).not.toContain('OUTREACH_V3_CONTEXT_ENABLED');

    const packageJson = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
    const apiPackage = readApi('package.json');
    expect(`${packageJson}\n${apiPackage}`).not.toMatch(/@langchain\/langgraph|LANGGRAPH_|LANGSMITH_/);

    const appSource = productionFiles(resolve(REPO_ROOT, 'apps'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(appSource).not.toMatch(/class\s+OutreachApiAppModule|apps\/outreach-api/);
  });
});
