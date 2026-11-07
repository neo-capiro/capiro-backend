// Actual Core bind and Strategy receiver, with synthetic observed source and
// fetch only. Unused framework/database observation ports fail if called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, registerHooks } from 'node:module';
import { objectiveStrategyIntakeUrl } from './objective-strategy-request-loader.mjs';

const root = new URL('../../../', import.meta.url);
const data = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const framework = data(`
  export const Injectable=()=>{throw Error('UNUSED_FRAMEWORK');};
  export class Logger { warn(){} }
  export class ServiceUnavailableException extends Error { constructor(m){super(m);this.status=503;} }
  export class BadRequestException extends Error { constructor(m){super(typeof m==='string'?m:JSON.stringify(m));this.status=400;} }
  export class ConflictException extends Error { constructor(m){super(typeof m==='string'?m:JSON.stringify(m));this.status=409;} }
  export class NotFoundException extends Error {}
  export class ConfigService { constructor(){throw Error('UNUSED_CONFIG');} }
`);
const unused = data(`
  const no=()=>{throw Error('UNUSED_OBSERVATION_PORT');};
  export const requireClientObjectiveDestinationRevision=no,readStrategyReferenceWitness=no,classifyStaffKind=no;
  export class ClientObjectiveDestinationError extends Error {}
  export class DirectoryService { constructor(){no();} }
  export class RepresentationResolverService { constructor(){no();} }
  export class PrismaService { constructor(){no();} }
`);
const aliases = new Map([
  'apps/api/src/common/us-congressional-districts',
  'apps/api/src/clients/client-profile-fill-completion-projection',
  'apps/api/src/clients/client-profile-fill.helpers',
  'apps/api/src/clients/client-profile-fill-completion-runtime.shared',
].map(path => [new URL(`${path}.js`, root).href, new URL(`${path}.ts`, root).href]));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@capiro/shared/objective-context-budget' || specifier === '@capiro/shared/strategy-intake')
    return nextResolve(new URL(`packages/shared/src/${specifier.split('/').at(-1)}.ts`, root).href, context);
  let mapped; try { mapped = aliases.get(new URL(specifier, context.parentURL).href); } catch {}
  return nextResolve(mapped ?? specifier, context);
} });
function source(path, replacements = [], decorated = false) {
  const url = new URL(path, root); let text = readFileSync(url, 'utf8');
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `declared import ${path}: ${from}`);
    text = text.replaceAll(from, JSON.stringify(to));
  }
  if (decorated) { assert.equal(text.split('@Injectable()').length, 2); text = text.replace('@Injectable()', ''); }
  return data(stripTypeScriptTypes(text, { mode: 'transform', sourceUrl: url.href }));
}
const corePrefix = 'apps/api/src/context/';
const pure = name => new URL(`${corePrefix}${name}.ts`, root).href;
const producer = await import(source(`${corePrefix}objective-generation-context.service.ts`, [
  ["'@nestjs/common'", framework], ["'@capiro/shared'", unused],
  ["'@capiro/shared/objective-strategy-intake'", objectiveStrategyIntakeUrl],
  ...['../directory/directory.service.js', '../clients/representation-resolver.service.js', '../clients/client-targets.service.js', '../prisma/prisma.service.js']
    .map(path => [`'${path}'`, unused]),
  ["'../common/district-code.util.js'", new URL('apps/api/src/common/district-code.util.ts', root).href],
  ...['objective-generation-sources', 'objective-generation-typed-context', 'objective-generation-evidence', 'objective-generation-background']
    .map(name => [`'./${name}.js'`, pure(name)]),
], true));
const typesUrl = source('apps/api-strategy/src/meri/objective-generation.types.ts', [
  ["'@nestjs/common'", framework], ["'@capiro/shared/objective-strategy-intake'", objectiveStrategyIntakeUrl],
]);
const { digest } = await import(typesUrl);
const { StrategyContextPlaneClient } = await import(source('apps/api-strategy/src/meri/strategy-context-plane.client.ts', [
  ["'@nestjs/common'", framework], ["'@nestjs/config'", framework], ["'./objective-generation.types.js'", typesUrl],
], true));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(partial = false) {
  const input = { tenantId: id(1), clerkUserId: 'user_synthetic', clientId: id(2), mode: 'draft',
    objective: { objectiveId: id(3), objectiveVersion: 2 }, generationRequestId: id(4), generationType: 'appropriations', objectiveTypedContext: true };
  const source = { clientId: id(2), objectiveId: id(3), objectiveVersion: 2, objectiveRevisionId: id(5) };
  const intent = { outcome: 'Synthetic goal', governmentProblem: 'Synthetic problem', askType: 'funding', minimumWin: 'Synthetic win', limits: '' };
  const groups = Object.fromEntries(Object.keys(producer.OBJECTIVE_FIELD_INVENTORY).map(name => [name, []]));
  groups.government_profile_support = [{ ...Object.fromEntries(producer.OBJECTIVE_FIELD_INVENTORY.government_profile_support.map(name => [name, null])),
    id: id(2), description: 'COMPLETE_SYNTHETIC_PROFILE_' + 'x'.repeat(120000) }];
  const observed = { issues: [], sources: groups, contacts: [], contactIds: [], source, intent, observedAt: '2026-11-07T00:00:00.000Z',
    sourceDigest: producer.objectiveDigest({ source, intent }), localDigest: 'a'.repeat(64), externalDigest: 'b'.repeat(64), snapshotSha256: 'c'.repeat(64),
    background: { groups: { profile_fill_corpus: [], profile_fill_runs: [], profile_fill_tasks: [], profile_fill_findings: [] } } };
  const coverage = { complete: !partial, paginationComplete: !partial, truncated: partial };
  const body = { kind: partial ? 'release_switch_rollback' : 'governed_packet', records: [], coverage,
    governedContext: { version: 1, operationId: 'strategies.generate', prompt: 'original',
      contextPacket: { packetId: id(6), compiledAt: observed.observedAt, persisted: true, degraded: partial, surface: 'strategy', clientId: id(2) },
      retrieval: { coverage } } };
  const prompt = { steering: '', retrieval: '', compose: (intentText, recordsText) => `Synthetic context\n${intentText}\n${recordsText}` };
  body.objectiveAdmission = new producer.ObjectiveGenerationContextService(undefined, undefined, undefined)
    .bind(input, observed, body, 'd'.repeat(64), [], prompt);
  return { input, body };
}
async function receive(f) {
  const old = globalThis.fetch, admitted = [], typed = [];
  globalThis.fetch = async () => Response.json(f.body);
  try {
    const client = new StrategyContextPlaneClient({ get: name => name === 'INTERNAL_SERVICE_SECRET' ? 'synthetic-secret' : undefined });
    const result = await client.compile(f.input, async value => admitted.push(value), async value => typed.push(value));
    return { result, admitted, typed };
  } finally { globalThis.fetch = old; }
}
for (const partial of [false, true]) test(`actual Core ${partial ? 'partial supplementary' : 'complete'} packet crosses the Strategy receiver`, async () => {
  const f = fixture(partial), result = await receive(f);
  assert.ok(f.body.governedContext.prompt.length > 100000);
  assert.deepEqual(result.result, f.body.governedContext);
  assert.deepEqual(result.admitted, [f.body.objectiveAdmission]);
  assert.deepEqual(result.typed, [f.body.objectiveTypedContext]);
});
test('an obsolete policy digest remains refused even when its input digest is recomputed', async () => {
  const f = fixture(), a = f.body.objectiveAdmission;
  a.context.coverageDigest = digest({ manifest: a.coverage, history: f.body.governedContext.retrieval.coverage, policy: 'objective-v1-required-lossless' });
  a.context.inputDigest = digest({ sourceDigest: a.context.sourceDigest, coverageDigest: a.context.coverageDigest,
    packetId: a.context.packetId, requestId: a.requestId, type: a.type, localDigest: a.localDigest,
    externalDigest: a.externalDigest, historyDigest: a.historyDigest, promptDigest: digest(f.body.governedContext.prompt) });
  await assert.rejects(receive(f), /Objective context scope validation failed/);
});
test('changed prompt bytes and coverage remain refused', async () => {
  const f = fixture(); f.body.governedContext.prompt += ' changed';
  await assert.rejects(receive(f), /Objective context scope validation failed/);
  const g = fixture(); g.body.governedContext.retrieval.coverage.truncated = true;
  await assert.rejects(receive(g), /Objective context scope validation failed/);
});
