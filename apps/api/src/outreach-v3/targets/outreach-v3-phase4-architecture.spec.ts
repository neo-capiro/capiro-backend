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

describe('Outreach V3 Revised Phase 4 architecture', () => {
  it('freezes the exact dark target route contract', () => {
    const controller = readApi('src/outreach-v3/targets/outreach-v3-targets.controller.ts');
    const manifest = JSON.parse(
      readApi('src/outreach-v3/__fixtures__/outreach-v3-target-route-manifest.v1.json'),
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
      featureFlag: 'OUTREACH_V3_TARGETS_ENABLED',
      disabledBehavior: 404,
    });
  });

  it('mounts target intelligence only in the existing engagement-api runtime', () => {
    const engagement = readApi('src/engagement-api.app.module.ts');
    const main = readApi('src/app.module.ts');
    expect(engagement).toContain('OutreachV3TargetsModule');
    expect(main).not.toContain('OutreachV3TargetsModule');
    expect(main).not.toContain('outreach-v3/targets');
  });

  it('keeps target commands deterministic and server-resolved', () => {
    const engine = readApi('src/outreach-v3/services/outreach-command-engine.service.ts');
    const reducer = readApi('src/outreach-v3/state/outreach-command-reducer.ts');
    const contract = readApi('src/outreach-v3/state/outreach-command.contract.ts');
    expect(contract).toContain("'ADD_TARGET_REFS'");
    expect(contract).toContain("'REMOVE_TARGET_REFS'");
    expect(contract).toContain("'REJECT_TARGET_RECOMMENDATION'");
    expect(engine).toContain('resolveManyWithinTx');
    expect(engine).toContain('reauthorizeSnapshotsWithinTx');
    expect(reducer).toContain('resolvedTargetRefs');
    expect(reducer).not.toMatch(/PrismaService|DirectoryService|CapabilityRegistry|fetch\(/);
  });

  it('allows reasoning to propose but never apply grounded target changes', () => {
    const reasoningRoot = resolve(API_ROOT, 'src/outreach-v3/reasoning');
    const source = productionFiles(reasoningRoot)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(source).toContain('search_targets');
    expect(source).toContain('get_target_profile');
    expect(source).toContain('analyze_relationships');
    expect(source).toContain('createModelProposalWithinTx');
    expect(source).not.toContain('OutreachCommandEngineService');
    expect(source).not.toContain('.applyProposal(');
    expect(source).not.toContain('.applyBatch(');
    expect(source).not.toContain('SEND_EMAIL_NOW');
  });

  it('keeps Phase 4 read-only and leaves context/generation/send commands future-owned', () => {
    const commands = readApi('src/outreach-v3/state/outreach-command.contract.ts');
    const contextSchema = readApi('src/outreach-v3/state/outreach-campaign-spec.v1.ts');
    for (const future of [
      'ACCEPT_CONTEXT_REFS',
      'EXCLUDE_CONTEXT_REFS',
      'REQUEST_SAMPLE_GENERATION',
      'REQUEST_FULL_GENERATION',
      'REQUEST_SEND_REVIEW',
    ]) {
      expect(commands).toContain(`'${future}'`);
    }
    expect(contextSchema).toContain('reservedFutureContextRefsSchema');
    expect(contextSchema).not.toContain('wizardStep');
    expect(contextSchema).not.toContain('currentStage');
  });

  it('does not implement the new Outreach UI or add another service', () => {
    const webRoot = resolve(REPO_ROOT, 'apps/web/src');
    const webSource = productionFiles(webRoot)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(webSource).not.toContain('/outreach-v3/sessions/');
    expect(webSource).not.toContain('OUTREACH_V3_TARGETS_ENABLED');
    const repoSource = productionFiles(resolve(REPO_ROOT, 'apps'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(repoSource).not.toMatch(/class\s+OutreachApiAppModule|apps\/outreach-api/);
  });

  it('does not introduce LangGraph or a general LangChain agent', () => {
    const packageJson = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
    const apiPackage = readApi('package.json');
    const combined = `${packageJson}\n${apiPackage}`;
    expect(combined).not.toMatch(/@langchain\/langgraph|LANGGRAPH_|LANGSMITH_/);
  });
});
