#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'origin/main';

/**
 * Files that ARE the shared Context Plane (or the shared Retrieval V2 it owns).
 * Implementation internals are expected here; the guard polices everything else.
 */
const IMPLEMENTATION_PREFIXES = [
  'apps/api/src/context/',
  'apps/api/src/retrieval/',
  'packages/meriv2-core/src/context/',
];

const TEST_SUFFIXES = ['.spec.ts', '.test.ts'];

/**
 * Product code must consume ContextPlaneGatewayService, not reach through the
 * gateway to individual resolver/compiler/packet/retrieval implementations.
 *
 * Path patterns are ANCHORED to the shared Context Plane directory on purpose.
 * `apps/workspace/src/generation/context-compiler.service.ts` and
 * `apps/meriv2-orchestrator/src/meri/context-compiler.service.ts` are different
 * modules that merely share a filename; matching a bare filename made this
 * guard fire on unrelated product-local code.
 *
 * Class-name patterns use \b, which does NOT match the product-local
 * `WorkspaceContextCompilerService` / `OrchestratorContextCompilerService`
 * (there is no word boundary mid-identifier). That is intentional: those are
 * separate services governed by their own adoption tests, not shared-plane
 * internals.
 */
const BANNED_ADDITION_PATTERNS = [
  // Shared Context Plane implementation modules, reached by relative or absolute path.
  /(?:\.{1,2}\/)+context\/context-compiler\.service/,
  /(?:\.{1,2}\/)+context\/context-packet-v2\.service/,
  /(?:\.{1,2}\/)+context\/context-resolver\.service/,
  /(?:\.{1,2}\/)+retrieval\/retrieval-v2\.service/,
  /apps\/api\/src\/context\/context-(?:compiler|packet-v2|resolver)\.service/,
  /apps\/api\/src\/retrieval\/retrieval-v2\.service/,
  // Shared-plane exported symbols.
  /\bContextCompilerService\b/,
  /\bContextPacketV2Service\b/,
  /\bContextResolverService\b/,
  /\bRetrievalV2Service\b/,
  /\bContextPacketRolloutCompiler\b/,
  /\bTruthfulContextCompiler\b/,
  /\bcompileCoverageAwareContextPacket\b/,
  /\bresolveTenantContextPacketMode\b/,
  /\bresolveContextPacketMode\b/,
];

/**
 * Explicitly reviewed thin adapters. Each entry is an EXACT trimmed source line
 * plus the reason it is architecturally sound. An allowlisted line stops being
 * allowlisted the moment it changes, so this cannot rot into a blanket waiver.
 */
const APPROVED_ADAPTER_LINES = [
  {
    file: 'apps/api/src/workspace-assistant/workspace-assistant.module.ts',
    line: "import { ContextCompilerService } from '../context/context-compiler.service.js';",
    reason:
      'DI token only, for the substitution below. The symbol is never constructed or called here.',
  },
  {
    file: 'apps/api/src/workspace-assistant/workspace-assistant.module.ts',
    line: '{ provide: ContextCompilerService, useExisting: WorkspaceEditorContextCompilerAdapter },',
    reason:
      'Phase 21 substitution: the legacy WorkspaceAssistantService dependency is REPLACED by the governed adapter, so the editor path cannot reach the real compiler. Removing this line would restore the bypass.',
  },
];

function isApproved(file, addedLine) {
  return APPROVED_ADAPTER_LINES.some(
    (entry) => entry.file === file && entry.line === addedLine.trim(),
  );
}

/**
 * Comment-only lines are not architecture. A doc comment that NAMES a retired
 * bypass in order to state that the code no longer uses it must not fail the
 * guard — that made the guard unrunnable, and it was never green before this.
 */
function isCommentOnly(line) {
  const t = line.trim();
  return (
    t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/')
  );
}

/** Strip comments so HEAD invariants match real code, not prose about it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const EXPECTED_OPERATIONS = [
  'meri.chat',
  'meri.research',
  'research.generate-report',
  'outreach.generate',
  'workspace.generate',
  'workspace.editor-assist',
  'legiwatch.generate-report',
  'crm.fill-with-meri',
  'meetings.prep-debrief',
  'strategies.generate',
];

let diff = '';
try {
  diff = execFileSync(
    'git',
    [
      'diff',
      '--unified=0',
      '--no-color',
      `${base}...HEAD`,
      '--',
      ':(glob)**/*.ts',
      ':(glob)**/*.tsx',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
} catch (error) {
  console.error(`Context Plane guard could not diff against ${base}.`);
  throw error;
}

const violations = [];
let file = null;
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    file = line.slice('+++ b/'.length);
    continue;
  }
  if (!file || !line.startsWith('+') || line.startsWith('+++')) continue;
  if (IMPLEMENTATION_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
  if (TEST_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;

  const added = line.slice(1);
  if (isCommentOnly(added)) continue;
  if (isApproved(file, added)) continue;

  const matched = BANNED_ADDITION_PATTERNS.find((pattern) => pattern.test(added));
  if (matched) violations.push({ file, added: added.trim(), pattern: String(matched) });
}

/**
 * Phase 26 closes the bounded product migration sequence. These HEAD invariants
 * are intentionally stronger than the added-line guard: once adopted, a product
 * cannot reintroduce its old exception/compiler even by moving or restoring old
 * code in a later PR.
 */
const REGISTRY = 'apps/api/src/context/context-plane-operation-registry.ts';
const registry = read(REGISTRY);
for (const operationId of EXPECTED_OPERATIONS) {
  requireText(REGISTRY, registry, `id: '${operationId}'`);
}
for (const retired of [
  'defineContextMigrationException',
  'migrationOperation({',
  'phase25-strategies-adoption',
]) {
  forbidText(REGISTRY, registry, retired);
}
// Every registered operation must be packet_required; the registry asserts this
// at module load. Losing that assertion would silently allow migration debt.
requireText(REGISTRY, registry, 'context_operation_migration_debt_remains');

const STRATEGY_MAIN = 'apps/api/src/context/strategy-context-plane.service.ts';
const strategyMain = read(STRATEGY_MAIN);
requireText(STRATEGY_MAIN, strategyMain, 'ContextPlaneGatewayService');
// A Strategy-originated artifact must compile under its DESTINATION operation.
for (const destination of [
  "operationId: 'strategies.generate'",
  "operationId: 'workspace.generate'",
  "operationId: 'outreach.generate'",
]) {
  requireText(STRATEGY_MAIN, strategyMain, destination);
}

const STRATEGY_MODULE = 'apps/api-strategy/src/meri/meri.module.ts';
const strategyModule = read(STRATEGY_MODULE);
for (const required of ['createGovernedStrategyMeriService', 'RAW_STRATEGY_MERI_SERVICE']) {
  requireText(STRATEGY_MODULE, strategyModule, required);
}

// The isolated Strategy service must reach context ONLY through the guarded
// backend bridge, and its reasoning hops must fail closed without it.
const STRATEGY_CLIENT = 'apps/api-strategy/src/meri/strategy-orchestrator.client.ts';
const strategyClient = read(STRATEGY_CLIENT);
for (const required of ['governedBody', 'currentStrategyGovernedContext']) {
  requireText(STRATEGY_CLIENT, strategyClient, required);
}

const STRATEGY_PACK =
  'apps/meriv2-orchestrator/src/meri/strategy/strategy-context-pack.service.ts';
const strategyPack = stripComments(read(STRATEGY_PACK));
requireText(STRATEGY_PACK, strategyPack, 'currentGovernedMeriContext');
for (const retiredBypass of [
  'ApiToolExecutorRepo',
  'search_memory',
  'query_knowledge_graph',
  'search_client_knowledge',
  'get_client_context',
]) {
  forbidText(STRATEGY_PACK, strategyPack, retiredBypass);
}

const STRATEGY_CONTROLLER = 'apps/meriv2-orchestrator/src/meri/strategy/strategy.controller.ts';
const strategyController = read(STRATEGY_CONTROLLER);
for (const required of [
  'requireInternalContextProxy',
  'requireGovernedContext',
  'this.resolver.resolveIdentity',
  'runWithGovernedMeriContext',
]) {
  requireText(STRATEGY_CONTROLLER, strategyController, required);
}
/**
 * Presence of a helper is NOT proof it runs. Deleting every CALL while leaving
 * the definition behind satisfied a plain substring check, so the three governed
 * Strategy reasoning routes (draft, assistant, document-draft) are counted
 * explicitly. These count the call form, which the `function` declaration line
 * does not match.
 */
requireCount(STRATEGY_CONTROLLER, strategyController, 'requireInternalContextProxy(req);', 3);
requireCount(STRATEGY_CONTROLLER, strategyController, 'requireGovernedContext(dto', 3);
requireCount(STRATEGY_CONTROLLER, strategyController, 'runWithGovernedMeriContext(governed', 3);
requireCount(STRATEGY_CONTROLLER, strategyController, 'this.resolver.resolveIdentity(tc)', 3);
// Every governed reasoning hop out of api-strategy must pass through governedBody().
requireCount(STRATEGY_CLIENT, strategyClient, 'this.governedBody(', 3);

// strategies_work is a READ-ONLY projection. Execution-sensitive Strategy
// internals must never be reachable through shared retrieval.
const STRATEGY_ADAPTER = 'apps/api/src/retrieval/adapters/strategy-work-retrieval.adapter.ts';
const strategyAdapter = stripComments(read(STRATEGY_ADAPTER));
for (const forbiddenTable of [
  'sp_agent_run',
  'sp_change_set',
  'sp_event_outbox',
  'sp_strategy_chat_message',
  'sp_approval',
  'sp_send_token',
]) {
  forbidText(STRATEGY_ADAPTER, strategyAdapter, forbiddenTable);
}
for (const mutation of ['INSERT ', 'UPDATE ', 'DELETE ', '$executeRaw']) {
  forbidText(STRATEGY_ADAPTER, strategyAdapter, mutation);
}

/**
 * Phase 26 cut Outreach over to the governed GenerationGateway and deleted the
 * legacy path. Before that, ENGAGEMENT_GENERATION_GATEWAY defaulted to false and
 * the live branch compiled an ungoverned ContextPacket through the shared
 * compiler, so outreach.generate was packet_required in the registry while the
 * default runtime path held no packet at all. These invariants stop that whole
 * shape from returning: no product-owned compiler use anywhere under the
 * Engagement tree, and no flag that can re-fork generation onto an ungoverned
 * branch.
 */
const ENGAGEMENT_ROOT = 'apps/api/src/engagement';
for (const file of sourceFilesUnder(ENGAGEMENT_ROOT)) {
  const code = stripComments(readOptional(file));
  for (const banned of [
    'ContextCompilerService',
    'ContextPacketV2Service',
    'ContextResolverService',
    'RetrievalV2Service',
  ]) {
    forbidText(file, code, banned);
  }
  // A generation fork on the gateway flag is what made the bypass reachable.
  forbidText(file, code, 'gateway.enabled');
}

const GENERATION_GATEWAY = 'apps/api/src/engagement/generation/generation-gateway.service.ts';
const generationGateway = stripComments(read(GENERATION_GATEWAY));
// The gateway resolves the packet unconditionally and never returns a draft whose
// provenance could not be recorded.
requireText(GENERATION_GATEWAY, generationGateway, 'this.contextPlane.resolve(');
requireText(GENERATION_GATEWAY, generationGateway, 'failClosedOnPersist: true');

if (violations.length > 0) {
  console.error('\nContext Plane architecture violation.');
  console.error(
    'Use ContextPlaneGatewayService and the adopted product boundary. A genuine exception requires an explicit reviewed architecture change (see APPROVED_ADAPTER_LINES).\n',
  );
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.added}`);
  }
  process.exit(1);
}

console.log(
  `Context Plane architecture guard: no new direct bypass imports; all ${EXPECTED_OPERATIONS.length} adopted-product invariants hold.`,
);

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Every non-spec TypeScript file under a directory, relative-pathed. */
function sourceFilesUnder(root) {
  const out = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !TEST_SUFFIXES.some((s) => path.endsWith(s))) out.push(path);
    }
  };
  walk(root);
  return out;
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    violations.push({ file: path, added: 'required file missing', pattern: 'HEAD invariant' });
    return '';
  }
}

function requireCount(path, text, needle, min) {
  const found = text.split(needle).length - 1;
  if (found < min) {
    violations.push({
      file: path,
      added: `expected at least ${min} call site(s) of \`${needle}\`, found ${found}`,
      pattern: 'HEAD invariant (call count)',
    });
  }
}

function requireText(path, text, required) {
  if (!text.includes(required)) {
    violations.push({
      file: path,
      added: `missing required architecture marker: ${required}`,
      pattern: 'HEAD invariant',
    });
  }
}

function forbidText(path, text, forbidden) {
  if (text.includes(forbidden)) {
    violations.push({
      file: path,
      added: `retired architecture marker returned: ${forbidden}`,
      pattern: 'HEAD invariant',
    });
  }
}
