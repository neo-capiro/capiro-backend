import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'src')) && existsSync(resolve(cwd, 'prisma'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const API_ROOT = apiRoot();
const REPO_ROOT = resolve(API_ROOT, '../..');
const readApi = (path: string) => readFileSync(resolve(API_ROOT, path), 'utf8');
const readRepo = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf8');

/**
 * When ENGAGEMENT_PHASE3_SCOPE_END is set (by the combined/final verifiers),
 * restrict scope-sensitive invariants to files changed within Phase 2's
 * committed range only. Later phases (3-6) legitimately add V3 API calls
 * and flags to the web, so checking all current files would false-positive.
 */
const PHASE2_SCOPE_END = process.env.ENGAGEMENT_PHASE3_SCOPE_END;
const PHASE2_BASE_SHA =
  process.env.OUTREACH_V3_PHASE2_BASE_SHA || 'cf0aa80d8d16fbd1e775fc054e8de34570535e23';

function phase2ChangedFiles(): string[] {
  if (!PHASE2_SCOPE_END) return []; // unscoped — no restriction
  const result = spawnSync(
    'git',
    ['diff', '--name-only', `${PHASE2_BASE_SHA}...${PHASE2_SCOPE_END}`],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => resolve(REPO_ROOT, p));
}

const PHASE2_CHANGED = new Set(phase2ChangedFiles());

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__fixtures__') continue;
      files.push(...productionSourceFiles(path));
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.spec.tsx') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      files.push(path);
    }
  }
  return files;
}

function importSources(source: string): string[] {
  const results: string[] = [];
  const regex = /from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(regex)) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

function controllerRouteManifest(source: string) {
  const prefix = source.match(/@Controller\('([^']+)'\)/)?.[1];
  if (!prefix) throw new Error('controller prefix not found');
  const routes: Array<{ method: string; path: string; handler: string }> = [];
  const regex = /@(Get|Post)\('([^']+)'\)\s+([A-Za-z0-9_]+)\s*\(/g;
  for (const match of source.matchAll(regex)) {
    const verb = match[1];
    const suffix = match[2];
    const handler = match[3];
    if (!verb || suffix === undefined || !handler) continue;
    routes.push({
      method: verb.toUpperCase(),
      path: `/api/${prefix}/${suffix}`.replace(/\/+/g, '/'),
      handler,
    });
  }
  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

describe('Outreach V3 Revised Phase 2 architecture', () => {
  it('keeps the V3 state module only in engagement-api composition', () => {
    const engagementApp = readApi('src/engagement-api.app.module.ts');
    const mainApp = readApi('src/app.module.ts');
    expect(engagementApp).toContain("import { OutreachV3StateModule } from './outreach-v3/api/outreach-v3-state.module.js';");
    expect(engagementApp).toContain('OutreachV3StateModule');
    expect(mainApp).not.toContain('OutreachV3StateModule');
    expect(mainApp).not.toContain('outreach-v3/api');
  });

  it('keeps the pure reducer free of persistence, capability and external-action imports', () => {
    const reducerRel = 'apps/api/src/outreach-v3/state/outreach-command-reducer.ts';
    let reducer: string;
    if (PHASE2_SCOPE_END) {
      // When scoped, check the reducer at the Phase 2 scope end, not at HEAD.
      // Later phases may legitimately add capability imports to the reducer.
      const result = spawnSync('git', ['show', `${PHASE2_SCOPE_END}:${reducerRel}`], {
        cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32',
      });
      if (result.status !== 0) return; // file didn't exist at scope end
      reducer = result.stdout;
    } else {
      reducer = readApi('src/outreach-v3/state/outreach-command-reducer.ts');
    }
    const imports = importSources(reducer);
    for (const source of imports) {
      expect(source).not.toMatch(/prisma|capabilit|openai|langgraph|langchain|oauth|recall|microsoft|google|s3|mail|client-document|llm/i);
    }
  });

  it('contains no external provider/runtime dependency in Phase 2 production source', () => {
    const root = resolve(API_ROOT, 'src/outreach-v3');
    const allFiles = productionSourceFiles(root);
    const filesToCheck = PHASE2_SCOPE_END
      ? allFiles.filter((f) => PHASE2_CHANGED.has(f) && !f.includes('/reasoning/') && !f.includes('\\reasoning\\'))
      : allFiles;
    if (filesToCheck.length === 0) return; // no changes in scope
    const imports = filesToCheck.flatMap((file) => importSources(readFileSync(file, 'utf8')));
    for (const source of imports) {
      expect(source).not.toMatch(/openai|langgraph|langchain|microsoft|google|recall|s3|mail-sender|gmail|client-document|llm-completion/i);
    }
  });

  it('contains no legacy Outreach table write dependency in Phase 2 production source', () => {
    const root = resolve(API_ROOT, 'src/outreach-v3');
    const source = productionSourceFiles(root)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const table of [
      'outreach_records',
      'outreach_draft_artifacts',
      'outreach_draft_versions',
      'outreach_jobs',
      'outreach_job_items',
      'outreach_send_intents',
      'outreach_deliveries',
    ]) {
      expect(source).not.toContain(table);
    }
  });

  it('keeps the migration additive and isolated from legacy Outreach', () => {
    const migration = readApi(
      'prisma/migrations/20260908010000_outreach_v3_campaign_state/migration.sql',
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    for (const table of [
      'outreach_records',
      'outreach_draft_artifacts',
      'outreach_draft_versions',
      'outreach_jobs',
      'outreach_job_items',
      'outreach_send_intents',
      'outreach_deliveries',
    ]) {
      expect(migration).not.toContain(`"${table}"`);
    }
    expect(migration).toContain('outreach_state_versions_append_only');
    expect(migration).toContain('outreach_events_append_only');
    expect(migration).toContain('outreach_command_proposals_lifecycle');
    expect(migration).toContain('outreach_sessions_id_tenant_unique');
    expect(migration).toContain('outreach_state_versions_session_tenant_fkey');
    expect(migration).toContain('outreach_events_session_tenant_fkey');
    expect(migration).toContain('outreach_command_proposals_session_tenant_fkey');
    expect(migration).toContain('REVOKE DELETE ON "outreach_sessions" FROM capiro_app');
    expect(migration).toContain('REVOKE UPDATE, DELETE ON "outreach_events" FROM capiro_app');
  });

  it('keeps the focused Prisma contract exact and free of UI/reasoning state', () => {
    const schema = readApi('prisma/outreach-v3-phase2/schema.prisma');
    for (const model of [
      'OutreachSession',
      'OutreachStateVersion',
      'OutreachEvent',
      'OutreachCommandProposal',
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).not.toMatch(/\bclientId\b/);
    expect(schema).not.toMatch(/\b(wizardStep|currentStage|reasoning|chainOfThought)\b/);
  });

  it('keeps the committed route manifest byte-for-contract with the controller', () => {
    const controller = readApi('src/outreach-v3/api/outreach-v3-state.controller.ts');
    const manifest = JSON.parse(
      readApi('src/outreach-v3/__fixtures__/outreach-v3-route-manifest.v1.json'),
    ) as {
      runtime: string;
      featureFlag: string;
      disabledBehavior: number;
      routes: Array<{ method: string; path: string; handler: string }>;
    };
    const expected = [...manifest.routes].sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    );
    expect(controllerRouteManifest(controller)).toEqual(expected);
    expect(manifest.runtime).toBe('engagement-api');
    expect(manifest.featureFlag).toBe('OUTREACH_V3_STATE_ENABLED');
    expect(manifest.disabledBehavior).toBe(404);
  });

  it('does not add a V3 state call or enable flag to the current web application', () => {
    const webRoot = resolve(REPO_ROOT, 'apps/web/src');
    if (PHASE2_SCOPE_END) {
      // When scoped, only check web files changed within Phase 2's range.
      // Later phases (3-6) legitimately add V3 API clients to the web.
      const phase2WebFiles = productionSourceFiles(webRoot).filter((f) => PHASE2_CHANGED.has(f));
      if (phase2WebFiles.length === 0) return; // no web changes in Phase 2 scope
      const source = phase2WebFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
      expect(source).not.toContain('/outreach-v3/');
      expect(source).not.toContain('OUTREACH_V3_STATE_ENABLED');
    } else {
      const source = productionSourceFiles(webRoot)
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      expect(source).not.toContain('/outreach-v3/');
      expect(source).not.toContain('OUTREACH_V3_STATE_ENABLED');
    }
  });

  it('does not introduce OpenAI or LangGraph dependencies in package manifests', () => {
    const rootPackage = readRepo('package.json');
    const apiPackage = readApi('package.json');
    for (const packageText of [rootPackage, apiPackage]) {
      expect(packageText).not.toMatch(/"(?:openai|@openai\/[^"/]+|langgraph|@langchain\/langgraph|langchain)"\s*:/i);
    }
  });
});
