// Source-only codec controls. Actual owners are loaded without changing their
// bodies; unused framework/DB constructors below are explicit throwing ports.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { objectivePlannerOwnerCodecUrl } from './objective-strategy-request-loader.mjs';
export const custody = [];
const data = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
async function load(path, replacements = [], decorator = false) {
  const url = new URL(path, import.meta.url), raw = await readFile(url, 'utf8');
  let source = raw;
  for (const [from, to] of replacements) {
    const count = from === "'@capiro/shared/objective-planner-owner-codec'" ? 3 : 1;
    assert.equal(source.split(from).length, count + 1, `${path}: ${from}`);
    source = source.replaceAll(from, JSON.stringify(to));
  }
  if (decorator) {
    assert.equal(source.split('@Injectable()').length, 2);
    source = source.replace('@Injectable()', '');
  }
  const transformed = stripTypeScriptTypes(source, { mode: decorator ? 'transform' : 'strip', sourceUrl: url.href });
  custody.push({ path, sha256: createHash('sha256').update(raw).digest('hex'),
    transformedSha256: createHash('sha256').update(transformed).digest('hex'),
    replacements: replacements.map(([name]) => name), decorator });
  return data(transformed);
}
const app = await load('../src/planner/objective-canonical-application.ts', [["'@capiro/shared/objective-planner-owner-codec'", objectivePlannerOwnerCodecUrl]]);
const gen = await load('../src/meri/objective-canonical-generation.ts', [["'../planner/objective-canonical-application.js'", app]]);
const req = await load('../src/meri/objective-canonical-request.ts', [["'../planner/objective-canonical-application.js'", app], ["'./objective-canonical-generation.js'", gen]]);
const unused = data('export const Injectable=()=>{throw Error("UNUSED_FRAMEWORK");};export class ConfigService{constructor(){throw Error("UNUSED_CONFIG");}};export const buildSnapshot=()=>{throw Error("UNUSED_DB");};export const readCanonicalGenerationProducer=buildSnapshot,canonicalRegenerationSnapshot=buildSnapshot,checkCanonicalRegenerationNormalization=buildSnapshot;');
const reader = await load('../src/meri/objective-native-reader.ts', [["'@nestjs/common'", unused], ["'@nestjs/config'", unused], ["'../planner/objective-canonical-application.js'", app], ["'./objective-canonical-generation.js'", gen], ["'./objective-canonical-request.js'", req]], true);
const native = await load('../src/meri/objective-native-completion.ts', [["'../planner/objective-canonical-application.js'", app], ["'./objective-canonical-request.js'", req], ["'./objective-native-reader.js'", reader]]);
const initial = await load('../src/meri/objective-canonical-completion-receipt.ts', [["'../planner/objective-canonical-application.js'", app], ["'./objective-canonical-generation.js'", gen], ["'./objective-canonical-request.js'", req], ["'./objective-native-completion.js'", native]]);
const basis = await load('../src/meri/objective-canonical-basis.ts', [["'../planner/objective-canonical-application.js'", app], ["'./objective-canonical-generation.js'", gen], ["'../strategy/versioning.js'", unused], ["'./objective-canonical-producer-ledger.js'", unused], ["'./objective-canonical-regeneration-ledger.js'", unused]]);
const regenReq = await load('../src/meri/objective-canonical-regeneration-request.ts', [["'../planner/objective-canonical-application.js'", app], ["'./objective-canonical-generation.js'", gen], ["'./objective-canonical-basis.js'", basis], ["'./objective-canonical-request.js'", req]]);
const regen = await load('../src/meri/objective-canonical-regeneration-completion-receipt.ts', [["'../planner/objective-canonical-application.js'", app], ["'./objective-canonical-generation.js'", gen], ["'./objective-canonical-request.js'", req], ["'./objective-canonical-regeneration-request.js'", regenReq], ["'./objective-canonical-completion-receipt.js'", initial], ["'./objective-native-completion.js'", native]]);
const fixture = await load('./objective-native-envelope.fixture.ts', [["'../src/meri/objective-canonical-request.js'", req], ["'../src/meri/objective-canonical-generation.js'", gen]]);
export const application = await import(app), generation = await import(gen), request = await import(req),
  initialCodec = await import(initial), regenerationRequest = await import(regenReq), regenerationCodec = await import(regen),
  nativeCodec = await import(native), nativeFixture = (await import(fixture)).nativeObjectiveEnvelope;

/** Mutate literal result bytes while explicitly updating only its transport and
 * mirror descriptor. No model, SDK, authority, SQL or object custody is claimed. */
export function storeResult(f, { semantic = true, observation = true } = {}) {
  const r = f.result, p = f.raw.completion, d = p.typedResult, hash = request.privateRequestJcsSha256;
  if (semantic) { const { resultSha256: _hash, ...body } = r; r.resultSha256 = hash(body); }
  if (observation) {
    d.observation = { sessionId: p.sessionId, completedAtMs: r.completedAtMs, state: r.state, payloadSha256: r.payloadSha256 };
    r.execution.receiptSha256 = hash({ schemaVersion:1,operation:'strategy.draft',sourceAdmissionSha256:d.sourceAdmissionSha256,
      sourceRequestSha256:d.sourceRequestSha256,typedRequestSha256:d.typedRequestSha256,bindingSha256:r.execution.bindingSha256,
      provider:r.execution.provider,model:r.execution.model,receiptRef:r.execution.receiptRef,...d.observation });
    d.execution.receiptSha256 = r.execution.receiptSha256;
    if (semantic) { const { resultSha256: _hash, ...body } = r; r.resultSha256 = hash(body); }
  }
  const bytes = Buffer.from(JSON.stringify(r));
  f.raw.file.base64 = bytes.toString('base64');
  Object.assign(f.raw.file.object, { bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex') });
  p.proof.files.workspace.entries[0].object = structuredClone(f.raw.file.object);
  p.proof.checkpointSha256 = hash({ sdkSession:p.proof.sdkSession,files:p.proof.files });
  Object.assign(d, { resultSha256:r.resultSha256,fileSha256:f.raw.file.object.sha256,bytes:bytes.length });
}
