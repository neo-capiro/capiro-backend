#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */

import { execFileSync } from 'node:child_process';
import { readFileSync as readSourceFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import { architectureGuardBase, guardRef } from './cleanup-gates/lib/cli.mjs';
import {
  parseContextPlaneInvocation, projectContextPlaneDiff, partitionContextPlaneDiff, assertContextPlaneReadPath,
  contextPlaneIncludesPath, contextPlaneSourceFilesUnder,
} from './lib/context-plane-scope.mjs';

let invocation;
try {
  invocation = parseContextPlaneInvocation(process.argv.slice(2));
  if (invocation.scope !== 'full') guardRef(invocation.base, { name: 'base-ref' });
} catch (error) {
  console.error(`Context Plane scoped invocation refused: ${error.message}`);
  process.exit(2);
}
const { scope } = invocation;
const base = scope === 'full' ? architectureGuardBase('check-context-plane-new-bypasses') : invocation.base;

function readFileSync(path, encoding) {
  if (scope === 'full') return readSourceFileSync(path, encoding);
  try {
    assertContextPlaneReadPath(path, scope, { lstatSync });
    return readSourceFileSync(path, encoding);
  } catch (error) {
    violations.push({ file: path, added: `scoped source read refused: ${error.message}`, pattern: 'scope input refusal' });
    throw error;
  }
}

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
    file: 'apps/api/scripts/meriv2-phase18-application-rehearsal.ts',
    line: "const { ContextCompilerService } = await import('../src/context/context-compiler.service.js');",
    reason:
      'Existing offline Phase 18 database rehearsal harness import, deferred until its explicit CLI preflight succeeds. This script is not wired into a product module.',
  },
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
 * Repo-wide census of every non-plane source line that names a shared Context
 * Plane internal.
 *
 * The added-line guard above only sees a PR's diff, so it is blind to a bypass
 * that ALREADY sits on the base branch, and the Phase 26 HEAD invariants only
 * cover the registry, Strategy and the Engagement tree. A direct
 * ContextCompilerService consumer anywhere else could therefore live on main
 * indefinitely without any gate naming it. This census closes that hole: every
 * matching line in the repository must be accounted for here by EXACT trimmed
 * text, so an unlisted one fails the guard and a listed one cannot drift.
 *
 * status:
 *  - 'neutralized'  the symbol appears only as a type annotation or DI token;
 *                   the wiring substitutes something else, so the real
 *                   implementation is unreachable on the live path. Each one is
 *                   backed by a NEUTRALIZATION invariant further down.
 *  - 'unmigrated'   a genuine live consumer that still reaches the shared
 *                   compiler directly instead of ContextPlaneGatewayService, or
 *                   an offline harness that constructs it on purpose. These are
 *                   reported loudly on every run; they are NOT silent waivers.
 */
const SHARED_PLANE_CONSUMER_CENSUS = [
  {
    file: 'apps/api/scripts/meriv2-phase18-application-rehearsal.ts',
    line: "const { ContextCompilerService } = await import('../src/context/context-compiler.service.js');",
    status: 'unmigrated',
    reason:
      'Offline Phase 18 database rehearsal harness. Not wired into any Nest module, so it is not a product runtime path.',
  },
  {
    file: 'apps/api/scripts/meriv2-phase18-application-rehearsal.ts',
    line: 'const packet = await new ContextCompilerService(prisma).compile({',
    status: 'unmigrated',
    reason:
      'Rehearsal harness compiles a packet directly to prove the DB contract. Offline script, never served to a product operation.',
  },
  {
    file: 'apps/api/src/intelligence/alert-memo/alert-memo.service.ts',
    line: "import { ContextCompilerService } from '../../context/context-compiler.service.js';",
    status: 'neutralized',
    reason:
      'Type annotation only. alert-memo.module.ts constructs AlertMemoService with PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER, which throws.',
  },
  {
    file: 'apps/api/src/intelligence/alert-memo/alert-memo.service.ts',
    line: 'private readonly contextCompiler: ContextCompilerService,',
    status: 'neutralized',
    reason:
      'Phase 22: the injected value is the blocked stub, and LegiWatchContextPlaneService is the only live context seam.',
  },
  {
    file: 'apps/api/src/intelligence/alert-memo/district-brief.service.ts',
    line: "import { ContextCompilerService } from '../../context/context-compiler.service.js';",
    status: 'neutralized',
    reason:
      'Type annotation only. district-brief.module.ts injects PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER.',
  },
  {
    file: 'apps/api/src/intelligence/alert-memo/district-brief.service.ts',
    line: 'private readonly contextCompiler: ContextCompilerService,',
    status: 'neutralized',
    reason: 'Phase 22: the injected value is the blocked stub.',
  },
  {
    file: 'apps/api/src/meri/meri.module.ts',
    line: "import { ContextCompilerService } from '../context/context-compiler.service.js';",
    status: 'neutralized',
    reason: 'DI token for the two providers below.',
  },
  {
    file: 'apps/api/src/meri/meri.module.ts',
    line: 'contextCompiler: ContextCompilerService,',
    status: 'unmigrated',
    reason:
      'FUNDING_OPPORTUNITY_ASSESSMENT_WIRING hands the REAL compiler to MeriOpportunityAssessmentService. Funding-opportunity assessment is not one of the ten registered operations and predates the Phase 19-26 sequence, so it reaches context without ContextPlaneGatewayService. Best-effort and non-authoritative, but a live direct consumer.',
  },
  {
    file: 'apps/api/src/meri/meri.module.ts',
    line: 'ContextCompilerService,',
    status: 'unmigrated',
    reason: 'inject[] entry for the funding-opportunity assessment wiring above.',
  },
  {
    file: 'apps/api/src/meri/meri.service.ts',
    line: "import { ContextCompilerService } from '../context/context-compiler.service.js';",
    status: 'neutralized',
    reason: 'Type annotation for the constructor parameter below.',
  },
  {
    file: 'apps/api/src/meri/meri.service.ts',
    line: 'private readonly contextCompiler: ContextCompilerService,',
    status: 'neutralized',
    reason:
      'Reached only from loadUserVoiceContext, which runs only inside the legacy orchestrateContext. Phase 19 replaces orchestrateContext whenever a governed runtime is active, and createMeriRuntimeService wraps EVERY streamMessage in runChatTurn, so no chat turn can reach this compile. The Meri runtime invariants below pin that wrapping in place.',
  },
  {
    file: 'apps/api/src/workspace-assistant/workspace-assistant.module.ts',
    line: "import { ContextCompilerService } from '../context/context-compiler.service.js';",
    status: 'neutralized',
    reason: 'DI token only, for the substitution below.',
  },
  {
    file: 'apps/api/src/workspace-assistant/workspace-assistant.module.ts',
    line: '{ provide: ContextCompilerService, useExisting: WorkspaceEditorContextCompilerAdapter },',
    status: 'neutralized',
    reason:
      'Phase 21 substitution: the token resolves to the governed adapter, so the editor path cannot reach the real compiler.',
  },
  {
    file: 'apps/api/src/workspace-assistant/workspace-assistant.service.ts',
    line: "import { ContextCompilerService } from '../context/context-compiler.service.js';",
    status: 'neutralized',
    reason: 'Type annotation only; the module substitutes the governed adapter for this token.',
  },
  {
    file: 'apps/api/src/workspace-assistant/workspace-assistant.service.ts',
    line: 'private readonly contextCompiler: ContextCompilerService,',
    status: 'neutralized',
    reason: 'Receives WorkspaceEditorContextCompilerAdapter at runtime, not the shared compiler.',
  },
  {
    file: 'apps/meriv2-orchestrator/src/meri/context-compiler.service.ts',
    line: 'ContextPacketRolloutCompiler,',
    status: 'neutralized',
    reason:
      'Import for the product-local OrchestratorContextCompilerService. Its compile() is reached only by MeriContextResolver.resolve(), and every governed reasoning route (chat, in-editor, meriv3, all three Strategy hops) calls resolveIdentity() instead.',
  },
  {
    file: 'apps/meriv2-orchestrator/src/meri/context-compiler.service.ts',
    line: 'private readonly compiler: ContextPacketRolloutCompiler;',
    status: 'neutralized',
    reason: 'Field of the product-local orchestrator compiler; unreachable from governed routes.',
  },
  {
    file: 'apps/meriv2-orchestrator/src/meri/context-compiler.service.ts',
    line: 'this.compiler = new ContextPacketRolloutCompiler(adapter);',
    status: 'neutralized',
    reason:
      'Construction only. Remaining resolve() callers are strategy-reference-assist and meri.controller (clientId null, so no client pack) and steward-extract (records a packet id for provenance; its prompt reads no context layer).',
  },
];

const SHARED_PLANE_SYMBOL_PATTERNS = [
  /\bContextCompilerService\b/,
  /\bContextPacketV2Service\b/,
  /\bContextResolverService\b/,
  /\bRetrievalV2Service\b/,
  /\bContextPacketRolloutCompiler\b/,
  /\bTruthfulContextCompiler\b/,
  /\bcompileCoverageAwareContextPacket\b/,
  /\bdefineContextMigrationException\b/,
];

const CENSUS_SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

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
  diff = projectContextPlaneDiff(execFileSync(
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
  ), scope);
} catch (error) {
  console.error(`Context Plane guard could not diff against ${base}.`);
  if (scope !== 'full') console.error(`CONTEXT_PLANE_${scope.toUpperCase()}_FAILED`);
  throw error;
}

const violations = [];
if (scope === 'full') {
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
} else {
  for (const { path: file, additions } of partitionContextPlaneDiff(diff)) {
    if (IMPLEMENTATION_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    if (TEST_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
    for (const added of additions) {
      if (isCommentOnly(added)) continue;
      if (isApproved(file, added)) continue;
      const matched = BANNED_ADDITION_PATTERNS.find((pattern) => pattern.test(added));
      if (matched) violations.push({ file, added: added.trim(), pattern: String(matched) });
    }
  }
}

// Product adoption/neutralization invariants remain backend/full obligations.
if (scope !== 'frontend') {
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

/**
 * NEUTRALIZATION invariants. Each 'neutralized' census entry is only true while
 * its neutralizing wiring exists. Pin that wiring here, so deleting a
 * substitution turns a dormant type annotation back into a live bypass AND
 * fails this guard in the same commit.
 */
const LEGIWATCH_MEMO_MODULE = 'apps/api/src/intelligence/alert-memo/alert-memo.module.ts';
requireText(
  LEGIWATCH_MEMO_MODULE,
  stripComments(read(LEGIWATCH_MEMO_MODULE)),
  'PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER as never',
);
const LEGIWATCH_BRIEF_MODULE = 'apps/api/src/intelligence/alert-memo/district-brief.module.ts';
requireText(
  LEGIWATCH_BRIEF_MODULE,
  stripComments(read(LEGIWATCH_BRIEF_MODULE)),
  'PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER as never',
);
const LEGIWATCH_FACTORY =
  'apps/api/src/intelligence/alert-memo/governed-alert-deliverables.factory.ts';
requireText(
  LEGIWATCH_FACTORY,
  stripComments(read(LEGIWATCH_FACTORY)),
  'phase22_legacy_context_compiler_disabled',
);

const WORKSPACE_EDITOR_MODULE = 'apps/api/src/workspace-assistant/workspace-assistant.module.ts';
requireText(
  WORKSPACE_EDITOR_MODULE,
  stripComments(read(WORKSPACE_EDITOR_MODULE)),
  'useExisting: WorkspaceEditorContextCompilerAdapter',
);

/**
 * MeriService.loadUserVoiceContext compiles an UNGOVERNED v1 packet through the
 * shared compiler. It is unreachable only because Phase 19 swaps
 * orchestrateContext whenever a governed runtime is active and wraps every
 * streamMessage in runChatTurn. Losing either half would silently restore an
 * ungoverned meri.chat context path while meri.chat stays packet_required —
 * the exact shape Phase 26 had to remove from Outreach.
 */
const MERI_RUNTIME_PROXY = 'apps/api/src/meri/meriv3-runtime.proxy.ts';
const meriRuntimeProxy = stripComments(read(MERI_RUNTIME_PROXY));
for (const required of [
  "if (property === 'streamMessage')",
  'governedRuntime.runChatTurn(',
  'const governed = currentMeriGovernedRuntime();',
  'if (!governed) return originalOrchestrate(...args);',
]) {
  requireText(MERI_RUNTIME_PROXY, meriRuntimeProxy, required);
}
const MERI_MODULE = 'apps/api/src/meri/meri.module.ts';
const meriModule = stripComments(read(MERI_MODULE));
// MeriService must be exposed through the governed proxy, never directly.
requireText(MERI_MODULE, meriModule, 'useFactory: createMeriRuntimeService');
requireText(MERI_MODULE, meriModule, '{ provide: RAW_MERI_SERVICE, useClass: MeriService }');

}

/**
 * Repo-wide census sweep. Anything naming a shared-plane internal outside the
 * plane itself must be an exact, reviewed census line.
 */
const censusSeen = new Set();
let censusSourceCount = 0;
for (const root of ['apps', 'packages']) {
  for (const censusFile of sourceFilesUnder(root)) {
    censusSourceCount += 1;
    if (IMPLEMENTATION_PREFIXES.some((prefix) => censusFile.startsWith(prefix))) continue;
    const code = stripComments(readOptional(censusFile));
    if (!SHARED_PLANE_SYMBOL_PATTERNS.some((pattern) => pattern.test(code))) continue;
    for (const rawLine of code.split('\n')) {
      const line = rawLine.trim();
      if (!line || !SHARED_PLANE_SYMBOL_PATTERNS.some((pattern) => pattern.test(line))) continue;
      const entry = SHARED_PLANE_CONSUMER_CENSUS.find(
        (candidate) => candidate.file === censusFile && candidate.line === line,
      );
      if (!entry) {
        violations.push({
          file: censusFile,
          added: `unlisted shared-plane reference: ${line}`,
          pattern: 'HEAD invariant (repo-wide census)',
        });
        continue;
      }
      censusSeen.add(`${entry.file} ${entry.line}`);
    }
  }
}

if (scope !== 'full' && censusSourceCount === 0) {
  violations.push({ file: scope, added: 'empty scoped TypeScript census', pattern: 'scope input refusal' });
}

const scopedCensus = SHARED_PLANE_CONSUMER_CENSUS.filter((entry) => contextPlaneIncludesPath(entry.file, scope));
const staleCensus = scopedCensus.filter(
  (entry) => !censusSeen.has(`${entry.file} ${entry.line}`),
);
const unmigrated = scopedCensus.filter(
  (entry) => entry.status === 'unmigrated' && censusSeen.has(`${entry.file} ${entry.line}`),
);

if (violations.length > 0) {
  console.error('\nContext Plane architecture violation.');
  console.error(
    'Use ContextPlaneGatewayService and the adopted product boundary. A genuine exception requires an explicit reviewed architecture change (see APPROVED_ADAPTER_LINES).\n',
  );
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.added}`);
  }
  if (scope !== 'full') console.error(`CONTEXT_PLANE_${scope.toUpperCase()}_FAILED`);
  process.exit(1);
}

for (const entry of staleCensus) {
  console.warn(
    `Notice: census entry no longer present, delete it from SHARED_PLANE_CONSUMER_CENSUS — ${entry.file}: ${entry.line}`,
  );
}

if (scope === 'full') {
console.log(
  `Context Plane architecture guard: no new direct bypass imports; all ${EXPECTED_OPERATIONS.length} adopted-product invariants hold.`,
);
} else {
  console.log(`CONTEXT_PLANE_${scope.toUpperCase()}_COMPLETE`);
}
console.log(
  `Repo-wide census: ${censusSeen.size} reviewed shared-plane reference(s) outside the plane, ${unmigrated.length} still unmigrated.`,
);
if (unmigrated.length > 0) {
  // Deliberately loud. These are pinned, not waived: the repository does NOT
  // have zero direct shared-compiler consumers while this list is non-empty.
  console.log('\nUnmigrated direct shared-plane consumers (pinned, reviewed, not waived):');
  for (const entry of unmigrated) {
    console.log(`- ${entry.file}: ${entry.line}\n    ${entry.reason}`);
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Every non-spec TypeScript file under a directory, relative-pathed. */
function sourceFilesUnder(root) {
  if (scope !== 'full') {
    try {
      return contextPlaneSourceFilesUnder(root, scope, {
        skipDirectories: CENSUS_SKIP_DIRECTORIES, testSuffixes: TEST_SUFFIXES,
      }, { readdirSync, lstatSync });
    } catch (error) {
      violations.push({ file: root, added: `scoped source census refused: ${error.message}`, pattern: 'scope input refusal' });
      return [];
    }
  }
  const out = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      if (CENSUS_SKIP_DIRECTORIES.has(name)) continue;
      // Census pins use forward slashes so one list works on Windows and Linux.
      const path = join(directory, name).split('\\').join('/');
      if (statSync(path).isDirectory()) walk(path);
      else if (
        (path.endsWith('.ts') || path.endsWith('.tsx')) &&
        !TEST_SUFFIXES.some((s) => path.endsWith(s))
      ) {
        out.push(path);
      }
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
