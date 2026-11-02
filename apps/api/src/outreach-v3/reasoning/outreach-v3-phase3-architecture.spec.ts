import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'src/outreach-v3'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const API_ROOT = apiRoot();
const readApi = (path: string) => readFileSync(resolve(API_ROOT, path), 'utf8');

function productionFiles(root: string): string[] {
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

describe('Outreach V3 Revised Phase 3 architecture', () => {
  it('mounts reasoning only in engagement-api, never the main API', () => {
    const engagement = readApi('src/engagement-api.app.module.ts');
    const main = readApi('src/app.module.ts');
    expect(engagement).toContain('OutreachV3ReasoningModule');
    expect(main).not.toContain('OutreachV3ReasoningModule');
    expect(main).not.toContain('outreach-v3/reasoning');
  });

  it('does not expose the Phase 2 command engine to the reasoning module', () => {
    const stateModule = readApi('src/outreach-v3/api/outreach-v3-state.module.ts');
    const exportsText = stateModule.match(/exports:\s*\[([^\]]+)\]/s)?.[1] ?? '';
    expect(exportsText).toContain('OutreachSessionService');
    expect(exportsText).toContain('OutreachCommandProposalService');
    expect(exportsText).not.toContain('OutreachCommandEngineService');

    const reasoningRoot = resolve(API_ROOT, 'src/outreach-v3/reasoning');
    const reasoningSource = productionFiles(reasoningRoot)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(reasoningSource).not.toContain('OutreachCommandEngineService');
    expect(reasoningSource).not.toContain('.applyBatch(');
    expect(reasoningSource).not.toContain('.applyProposal(');
  });

  it('keeps visible conversation state separate from Campaign Spec truth', () => {
    const migration = readApi(
      'prisma/migrations/20261001012000_outreach_v3_reasoning_conversations/migration.sql',
    );
    expect(migration).toContain('outreach_reasoning_conversations');
    expect(migration).toContain('outreach_reasoning_turns');
    expect(migration).not.toMatch(
      /spec_jsonb|spec_hash|current_state_version|wizard_step|current_stage/i,
    );
    const stripped = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(stripped).not.toMatch(/chain.?of.?thought|scratchpad|hidden_reasoning|reasoning_text/i);
    expect(migration).toContain('outreach_reasoning_turns_append_only');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('keeps only historical get/list/archive routes and no provider dependency', () => {
    const controller = readApi('src/outreach-v3/reasoning/outreach-v3-reasoning.controller.ts');
    const module = readApi('src/outreach-v3/reasoning/outreach-v3-reasoning.module.ts');
    expect(
      controllerRoutes(controller)
        .map((route) => route.handler)
        .sort(),
    ).toEqual(['archiveConversation', 'getConversation', 'listTurns']);
    expect(module).not.toContain('OpenAiOutreachReasoningProvider');
    expect(module).not.toContain('OutreachReasoningTurnClaimService');
    expect(module).not.toContain('AiCredentialsModule');
  });
});
