import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Native source stripping only: no module hooks, compiler or temporary source.
// Preserve custody of the actual kernel, policy and regeneration helper before
// their declared source import rewrites.
const kernelUrl = new URL('../src/clients/objectives/work/objective-work-command.ts', import.meta.url);
const policyUrl = new URL('../src/auth/workload-authority/objective-consent-policy.ts', import.meta.url);
const kernelBytes = readFileSync(kernelUrl);
const policyBytes = readFileSync(policyUrl);
const kernelSource = kernelBytes.toString('utf8');
const policyImport = "'../../../auth/workload-authority/objective-consent-policy.js'";
assert.equal(kernelSource.split(policyImport).length - 1, 1, 'kernel must retain exactly one known policy import');
const regenerationUrl = new URL('../src/clients/objectives/work/objective-planner-regeneration.ts', import.meta.url);
const regenerationBytes = readFileSync(regenerationUrl);
const regenerationImport = "'./objective-planner-regeneration.js'";
assert.equal(kernelSource.split(regenerationImport).length - 1, 1, 'one declared regeneration helper import');
const regenerationModule = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(regenerationBytes.toString('utf8'),
  { mode: 'strip', sourceUrl: regenerationUrl.href })).toString('base64')}`;
const strippedKernel = stripTypeScriptTypes(
  kernelSource.replace(policyImport, JSON.stringify(policyUrl.href))
    .replace(regenerationImport, JSON.stringify(regenerationModule)),
  { mode: 'strip', sourceUrl: kernelUrl.href },
);
const custody = {
  kernelSha256: createHash('sha256').update(kernelBytes).digest('hex'),
  policySha256: createHash('sha256').update(policyBytes).digest('hex'),
  regenerationSha256: createHash('sha256').update(regenerationBytes).digest('hex'),
};
const {
  ObjectiveWorkError, parseWorkCommand, parseWorkRead, workDigest,
  executeWorkCommand, readWorkGeneration,
} = await import(`data:text/javascript;base64,${Buffer.from(strippedKernel).toString('base64')}`);

const ACTION = 'objective.strategy.draft';
const PLAN = 'objective.plan.prepare';
const INT_MAX = 2147483647;
const NOW = '2026-10-16T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const iso = (offset) => new Date(NOW_MS + offset).toISOString();
const id = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${n.toString(16).padStart(12, '0')}`;
const I = Object.freeze({
  tenant: id(1), client: id(2), objective: id(3), revision: id(4),
  rootActor: id(5), actor: id(6), membership: id(7), canonical: id(8),
  strategy: id(9), project: id(10), root: id(11), request: id(12),
});
const clone = (value) => structuredClone(value);
const key = (actor, action, requestId) => `${actor}:${action}:${requestId}`;
const body = (patch = {}) => ({
  schemaVersion: 1, requestId: I.request, command: 'retry', workAction: ACTION,
  expectedObjectiveVersion: 1, expectedControlVersion: 0,
  expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null,
  ...patch,
});
const request = (patch = {}) => parseWorkCommand(I.client, I.objective, body(patch));
const readRequest = (patch = {}) => parseWorkRead(I.client, I.objective, { workAction: ACTION, ...patch });
const codeIs = (code) => (error) => {
  assert.ok(error instanceof ObjectiveWorkError);
  assert.equal(error.code, code);
  return true;
};
const fails = (run, code) => assert.rejects(run, codeIs(code));
const invalid = (run) => assert.throws(run, codeIs('INVALID_REQUEST'));

/** A synthetic owner with serialized writes, cloned transactions and real
 * rollback. Its reconciliation port is explicitly authoritative test input;
 * it models no provider, database, workload identity or runtime admission. */
class MemoryOwner {
  constructor() {
    const source = {
      canonicalPlanId: I.canonical, canonicalEpoch: 1,
      canonicalStrategyId: I.strategy, canonicalProjectId: I.project,
      canonicalBindingVersion: 1, rootIntentId: I.root,
      sourceRevisionId: I.revision, sourceObjectiveVersion: 1,
      sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: I.rootActor,
    };
    this.data = {
      authority: {
        tenantId: I.tenant, actorUserId: I.actor, actorMembershipId: I.membership,
        clerkUserId: 'user_synthetic_writer', clientId: I.client, objectiveId: I.objective,
        objectiveRevisionId: I.revision, objectiveVersion: 1, objectiveStatus: 'ready',
      },
      states: {
        [ACTION]: { source: clone(source), control: null },
        [PLAN]: { source: clone(source), control: null },
      },
      consents: {}, receipts: {}, reconciliation: {},
      policy: {
        configuredDurationMs: null, tenantDurationLimitMs: null,
        actionDurationLimitMs: null, originalTokenExpiresAtMs: NOW_MS + 7200000,
        originalDelegationExpiresAtMs: null, limitReference: 'synthetic-current-authority',
      },
      now: NOW, clocks: [], nextId: 1000,
    };
    this.events = [];
    this.tail = Promise.resolve();
    this.denied = false;
    this.rejectCas = false;
    this.rejectReceipt = false;
    this.onState = null;
    this.beforeWrite = null;
    this.txSequence = 0;
  }

  async transaction(write, run) {
    let release = () => {};
    if (write) {
      const previous = this.tail;
      this.tail = new Promise((resolve) => { release = resolve; });
      await previous;
      if (this.beforeWrite) {
        const hook = this.beforeWrite; this.beforeWrite = null;
        await hook(this);
      }
    }
    const txId = ++this.txSequence;
    const draft = clone(this.data);
    const event = (method, extra = {}) => this.events.push({ txId, write, method, ...extra });
    const writable = () => assert.equal(write, true, 'GET/read transaction attempted a write');
    const tx = {
      lockOwner: async () => { writable(); event('lockOwner'); },
      currentAuthority: async () => {
        event('authority');
        if (this.denied) throw new ObjectiveWorkError('NOT_AVAILABLE');
        return clone(draft.authority);
      },
      receipt: async (authority, action, requestId) => {
        event('receipt', { action, requestId });
        return clone(draft.receipts[key(authority.actorUserId, action, requestId)] ?? null);
      },
      state: async (authority, action, createControl) => {
        event('state', { action, createControl });
        if (createControl) writable();
        if (this.onState) {
          const hook = this.onState; this.onState = null;
          await hook({ owner: this, draft, authority, action });
        }
        const state = draft.states[action];
        if (createControl && !state.control) {
          state.control = { id: id(action === ACTION ? 50 : 51), version: 0,
            currentConsentId: null, cancelledAt: null, cancelledByUserId: null };
        }
        return { source: clone(state.source), control: clone(state.control),
          consent: clone(draft.consents[state.control?.currentConsentId] ?? null) };
      },
      clock: async () => { event('clock'); return draft.clocks.shift() ?? draft.now; },
      reconcile: async (authority, action, state) => {
        event('reconcile', { action });
        return {
          state: 'not_started', tenantId: authority.tenantId, clientId: authority.clientId,
          objectiveId: authority.objectiveId, workAction: action,
          authorizationRequestId: state.control?.currentConsentId ?? null,
          rootIntentId: state.consent?.source.rootIntentId ?? state.source.rootIntentId,
          canonicalPlanId: state.source.canonicalPlanId, canonicalEpoch: state.source.canonicalEpoch,
          ...clone(draft.reconciliation[action] ?? {}),
        };
      },
      policy: async () => { event('policy'); return clone(draft.policy); },
      insertConsent: async (_authority, action, consent) => {
        writable(); event('insertConsent', { action });
        assert.equal(draft.consents[consent.id], undefined);
        draft.consents[consent.id] = clone(consent);
      },
      casControl: async (_authority, action, before, after) => {
        writable(); event('casControl', { action });
        const actual = draft.states[action].control;
        if (this.rejectCas || !actual || actual.version !== before.version ||
            actual.currentConsentId !== before.currentConsentId) return false;
        draft.states[action].control = clone(after);
        return true;
      },
      insertReceipt: async (authority, stored) => {
        writable(); event('insertReceipt');
        if (this.rejectReceipt) throw new Error('synthetic receipt insertion failure');
        const receiptKey = key(authority.actorUserId, stored.command.workAction, stored.command.requestId);
        assert.equal(draft.receipts[receiptKey], undefined);
        draft.receipts[receiptKey] = clone(stored);
      },
      newId: () => { writable(); event('newId'); return id(draft.nextId++); },
    };
    event('begin');
    try {
      const result = await run(tx);
      if (write) this.data = draft;
      event('commit');
      return result;
    } catch (error) {
      event('rollback');
      throw error;
    } finally { release(); }
  }
}

function seedConsent(owner, { action = ACTION, expired = true, version = 3 } = {}) {
  const source = clone(owner.data.states[action].source);
  const consent = {
    id: id(80), controlId: id(50), source, previousConsentId: null,
    actorUserId: id(81), actorMembershipId: id(82),
    policyId: 'capiro.objective-generation-consent', policyRevision: 1,
    configuredDurationMs: 1800000, effectiveDurationMs: 1800000,
    stricterExpiresAt: iso(expired ? -1 : 60000), stricterLimitRef: 'old-authority',
    confirmedAt: iso(expired ? -1800001 : -1740000), expiresAt: iso(expired ? -1 : 60000),
    commandRequestId: id(83), commandReceiptId: id(84), payloadDigest: 'b'.repeat(64),
  };
  owner.data.consents[consent.id] = clone(consent);
  owner.data.states[action].control = { id: consent.controlId, version,
    currentConsentId: consent.id, cancelledAt: null, cancelledByUserId: null };
  return clone(consent);
}
function accounted(outcome = 'failed') {
  return { state: 'accounted', operationId: id(90), attemptId: id(91), runId: id(92),
    requestFingerprint: 'c'.repeat(64), originalDeadlineAt: iso(-60000),
    terminalReceiptId: id(93), outcome };
}
const writes = (owner) => owner.events.filter((e) =>
  ['insertConsent', 'casControl', 'insertReceipt'].includes(e.method));
const storedReceipt = (owner, action = ACTION, actor = I.actor, requestId = I.request) =>
  owner.data.receipts[key(actor, action, requestId)];

export {
  ObjectiveWorkError, parseWorkCommand, parseWorkRead, workDigest, executeWorkCommand, readWorkGeneration,
  custody, ACTION, PLAN, INT_MAX, NOW, NOW_MS, iso, id, I, clone, key, body, request, readRequest,
  codeIs, fails, invalid, MemoryOwner, seedConsent, accounted, writes, storedReceipt,
};
