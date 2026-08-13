import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'src/outreach-v3'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const API_ROOT = apiRoot();
const REPO_ROOT = resolve(API_ROOT, '../..');
const readApi = (path: string) => readFileSync(resolve(API_ROOT, path), 'utf8');

/**
 * When ENGAGEMENT_PHASE3_SCOPE_END is set (by the combined/final verifiers),
 * restrict scope-sensitive invariants to files changed within Phase 3's
 * committed range only. Later phases (4-6) legitimately evolve the web and
 * tools surface, so checking all current files would false-positive.
 */
const PHASE3_SCOPE_END = process.env.ENGAGEMENT_PHASE3_SCOPE_END;
const PHASE3_BASE_SHA =
  process.env.OUTREACH_V3_PHASE3_BASE_SHA || '89b0a8e08e1cfcc7210a8684335faf6f8405bdf2';

function phase3ChangedFiles(): string[] {
  if (!PHASE3_SCOPE_END) return []; // unscoped — no restriction
  const result = spawnSync(
    'git',
    ['diff', '--name-only', `${PHASE3_BASE_SHA}...${PHASE3_SCOPE_END}`],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => resolve(REPO_ROOT, p));
}

const PHASE3_CHANGED = new Set(phase3ChangedFiles());

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

  it('keeps the provider tool surface read-only while allowing Phase 4 target intelligence', () => {
    const tools = readApi('src/outreach-v3/reasoning/outreach-reasoning-tools.ts');
    for (const allowed of [
      'get_capiro_record',
      'get_client_context',
      'get_recent_activity',
      'search_targets',
      'get_target_profile',
      'analyze_relationships',
      'analyze_target_coverage',
      'find_similar_targets',
    ]) {
      expect(tools).toContain(`'${allowed}'`);
    }
    // When scoped to Phase 3, only enforce the forbidden-tool invariant against
    // the tools file as it existed at Phase 3's end. Later phases (5/6) may
    // legitimately add governed tools like search_memory / research_government.
    const forbidden = ['SEND_EMAIL_NOW', 'REQUEST_FULL_GENERATION'];
    if (PHASE3_SCOPE_END) {
      const toolsPath = resolve(API_ROOT, 'src/outreach-v3/reasoning/outreach-reasoning-tools.ts');
      if (!PHASE3_CHANGED.has(toolsPath)) {
        // tools file was not changed within Phase 3 scope — skip Phase 3-era invariants
      } else {
        for (const f of forbidden) expect(tools).not.toContain(`'${f}'`);
      }
    } else {
      for (const forbiddenName of ['search_memory', 'research_government', ...forbidden]) {
        expect(tools).not.toContain(`'${forbiddenName}'`);
      }
    }
    expect(tools).toContain('assertOutreachReasoningToolContract');
  });

  it('defaults to Capiro-managed provider storage and gates provider state separately', () => {
    const service = readApi('src/outreach-v3/reasoning/outreach-reasoning.service.ts');
    expect(service).toContain("if (!raw || raw === 'capiro_managed') return 'capiro_managed'");
    expect(service).toContain('OUTREACH_V3_REASONING_PROVIDER_STATE_ENABLED');
    expect(service).toContain("store: conversation.stateMode === 'provider_state'");
    expect(service).toContain("conversation!.stateMode === 'capiro_managed' ? input.message : null");
  });

  it('keeps visible conversation state separate from Campaign Spec truth', () => {
    const migration = readApi(
      'prisma/migrations/20261001012000_outreach_v3_reasoning_conversations/migration.sql',
    );
    expect(migration).toContain('outreach_reasoning_conversations');
    expect(migration).toContain('outreach_reasoning_turns');
    expect(migration).not.toMatch(/spec_jsonb|spec_hash|current_state_version|wizard_step|current_stage/i);
    const stripped = migration.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(stripped).not.toMatch(/chain.?of.?thought|scratchpad|hidden_reasoning|reasoning_text/i);
    expect(migration).toContain('outreach_reasoning_turns_append_only');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('freezes the exact dark reasoning route manifest and Phase 2 state prerequisite', () => {
    const controller = readApi('src/outreach-v3/reasoning/outreach-v3-reasoning.controller.ts');
    const manifest = JSON.parse(
      readApi('src/outreach-v3/__fixtures__/outreach-v3-reasoning-route-manifest.v1.json'),
    ) as {
      runtime: string;
      featureFlag: string;
      requiresStateFlag: string;
      disabledBehavior: number;
      routes: Array<{ method: string; path: string; handler: string }>;
    };
    const expected = [...manifest.routes].sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    );
    expect(controllerRoutes(controller)).toEqual(expected);
    expect(manifest.runtime).toBe('engagement-api');
    expect(manifest.featureFlag).toBe('OUTREACH_V3_REASONING_ENABLED');
    expect(manifest.requiresStateFlag).toBe('OUTREACH_V3_STATE_ENABLED');
    expect(manifest.disabledBehavior).toBe(404);
  });

  it('does not add Phase 3 reasoning calls or flags to the current web', () => {
    const webRoot = resolve(REPO_ROOT, 'apps/web/src');
    if (PHASE3_SCOPE_END) {
      // When scoped, only check web files changed within Phase 3's range.
      // Later phases (5/6) legitimately add reasoning API clients to the web.
      const phase3WebFiles = productionFiles(webRoot).filter((f) => PHASE3_CHANGED.has(f));
      if (phase3WebFiles.length === 0) return; // no web changes in Phase 3 scope
      const source = phase3WebFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
      expect(source).not.toContain('/reasoning/conversations');
      expect(source).not.toContain('OUTREACH_V3_REASONING_ENABLED');
    } else {
      const source = productionFiles(webRoot)
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      expect(source).not.toContain('/reasoning/conversations');
      expect(source).not.toContain('OUTREACH_V3_REASONING_ENABLED');
    }
  });
});
