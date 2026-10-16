import { createHash, generateKeyPairSync } from 'node:crypto';
import { ObjectiveCurrentSourceUnavailable } from './objective-workload-current.js';
import {
  OBJECTIVE_GENERATION_WORKER_SUBJECT,
  OBJECTIVE_STRATEGY_AUDIENCE,
  verifyObjectiveWorkloadJwt,
  type ObjectiveWorkloadIssuerSigner,
  type ObjectiveWorkloadRequestBinding,
} from './objective-workload-jwt.js';
import {
  createObjectiveWorkloadIssuanceAdapter,
  ObjectiveWorkloadIssuanceError,
  type CurrentObjectiveIssuanceSource,
  type ObjectiveIssuanceInput,
  type ObjectiveIssuanceTransaction,
  type ObjectiveWorkloadIssueDecisionRecord,
  type ObjectiveWorkloadIssuanceRecord,
  type ObjectiveWorkloadProofUseRecord,
} from './objective-workload-issuance.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = 1_800_000_000;
const issuer = 'urn:capiro:objective-workload:core:test:v1';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const signer: ObjectiveWorkloadIssuerSigner = { issuer, kid: 'core-test-1', privateKey };
const binding: ObjectiveWorkloadRequestBinding = {
  subject: OBJECTIVE_GENERATION_WORKER_SUBJECT,
  audience: OBJECTIVE_STRATEGY_AUDIENCE,
  method: 'POST', path: '/strategy-api/internal/objective-canonical/generation-admissions',
  query: '', body: Buffer.from(`{"schemaVersion":1,"generationJobId":"${id(1)}"}`),
  operation: 'objective.strategy.draft', phase: 'admit',
  tenantId: id(2), generationJobId: id(1), delegationRef: id(3),
  consentId: id(4), attemptId: null, runId: null, acceptedBindingSha256: null,
};

function input(proofJti = id(10), proofIatSeconds = now): ObjectiveIssuanceInput {
  const rawIssuanceRequestBytes = Buffer.from(`{"operationId":"${id(5)}","phase":"admit"}`);
  return {
    selector: {
      tenantId: id(2), delegationRef: id(3), consentId: id(4),
      generationJobId: id(1), phase: 'admit',
    },
    proof: {
      issuer: 'urn:capiro:meri-worker:test:v1',
      subject: 'capiro-objective-generation-worker:v1',
      keyId: 'meri-worker-test-1', jti: proofJti, operationId: id(5),
      requestSha256: createHash('sha256').update(rawIssuanceRequestBytes).digest('hex'),
      iatSeconds: proofIatSeconds, nbfSeconds: proofIatSeconds,
      expSeconds: proofIatSeconds + 30,
    },
    rawIssuanceRequestBytes,
    binding: { ...binding, body: Buffer.from(binding.body) },
  };
}

function harness(enabled = true) {
  const store: {
    decisions: ObjectiveWorkloadIssueDecisionRecord[];
    issuances: ObjectiveWorkloadIssuanceRecord[];
    proofUses: ObjectiveWorkloadProofUseRecord[];
  } = { decisions: [], issuances: [], proofUses: [] };
  const source: CurrentObjectiveIssuanceSource = {
    enabled, databaseNowSeconds: now, validUntilSeconds: now + 120,
    tenantId: id(2), clientId: id(6), objectiveId: id(7),
    workAction: 'objective.strategy.draft', controlId: id(8),
    consentId: id(4), generationJobId: id(1), delegationRef: id(3),
    serviceSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT,
    audience: OBJECTIVE_STRATEGY_AUDIENCE,
  };
  let current: CurrentObjectiveIssuanceSource = source;
  let keyAvailable = true;
  let failProofInsert = false;
  let onLoadCurrent: (() => void) | null = null;
  let transactions = 0;
  let locks = 0;
  let allocations = 0;
  const port = {
    withTenantTransaction: async <T>(tenantId: string, run: (tx: ObjectiveIssuanceTransaction) => Promise<T>) => {
      transactions += 1;
      if (tenantId !== id(2)) throw new Error('wrong tenant scope');
      const snapshot = structuredClone(store);
      const tx: ObjectiveIssuanceTransaction = {
        lockOperation: async (operationId) => {
          if (operationId !== id(5)) throw new Error('wrong operation lock');
          locks += 1;
        },
        findDecision: async (operationId) =>
          snapshot.decisions.find((row) => row.operationId === operationId) ?? null,
        insertDecision: async (row) => { snapshot.decisions.push(row); },
        findIssuance: async (operationId) =>
          snapshot.issuances.find((row) => row.operationId === operationId) ?? null,
        insertIssuance: async (row) => { snapshot.issuances.push(row); },
        findProofUse: async (callerIssuer, proofJti) =>
          snapshot.proofUses.find((row) =>
            row.callerIssuer === callerIssuer && row.proofJti === proofJti) ?? null,
        insertProofUse: async (row) => {
          if (failProofInsert) throw new Error('proof insert failed');
          snapshot.proofUses.push(row);
        },
      };
      const result = await run(tx);
      store.decisions = snapshot.decisions;
      store.issuances = snapshot.issuances;
      store.proofUses = snapshot.proofUses;
      return result;
    },
    loadCurrent: async () => {
      onLoadCurrent?.();
      return current;
    },
  };
  const pins = {
    active: () => keyAvailable ? signer : null,
    byKid: (kid: string) => keyAvailable && kid === signer.kid ? signer : null,
  };
  const issue = createObjectiveWorkloadIssuanceAdapter(port, pins, () => {
    allocations += 1;
    return id(9);
  });
  return {
    issue, store,
    setSource: (change: Partial<CurrentObjectiveIssuanceSource>) => { current = { ...current, ...change }; },
    setKeyAvailable: (value: boolean) => { keyAvailable = value; },
    setFailProofInsert: (value: boolean) => { failProofInsert = value; },
    setOnLoadCurrent: (callback: () => void) => { onLoadCurrent = callback; },
    transactions: () => transactions, locks: () => locks, allocations: () => allocations,
  };
}

describe('source-only Objective issuance ledger adapter', () => {
  test('the migration disabled fence saves denial and proof use without allocating a JWT jti', async () => {
    const h = harness(false);
    await expect(h.issue(input())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.store.issuances).toHaveLength(0);
    expect(h.store.decisions).toMatchObject([{ decision: 'denied', operationId: id(5) }]);
    expect(h.store.proofUses).toMatchObject([{ operationDecision: 'denied', proofOutcome: 'denied' }]);
    expect(h.allocations()).toBe(0);
    expect(h.locks()).toBe(1);
  });

  test('synthetic enabled source commits one issuance and proof use in one transaction', async () => {
    const h = harness();
    const request = input();
    const result = await h.issue(request);
    expect(h.transactions()).toBe(1);
    expect(h.locks()).toBe(1);
    expect(h.allocations()).toBe(1);
    expect(h.store.issuances).toHaveLength(1);
    expect(h.store.decisions).toMatchObject([{ decision: 'issued', operationId: id(5) }]);
    expect(h.store.proofUses).toHaveLength(1);
    expect(h.store.proofUses[0]).toMatchObject({ operationDecision: 'issued', proofOutcome: 'issued' });
    expect(h.store.issuances[0]).toMatchObject({
      operationId: id(5), authorizationJti: id(9), signerKeyId: signer.kid,
      issuanceRequestSha256: request.proof.requestSha256,
      targetBodySha256: createHash('sha256').update(binding.body).digest('hex'),
      iatSeconds: BigInt(now), nbfSeconds: BigInt(now), expSeconds: BigInt(now + 60),
    });
    expect(h.store.proofUses[0]?.proofRequestSha256).toBe(request.proof.requestSha256);
    expect(verifyObjectiveWorkloadJwt(result.token, binding, {
      issuer, audience: OBJECTIVE_STRATEGY_AUDIENCE,
      publicKeys: { [signer.kid]: publicKey }, nowSeconds: now,
    }).jti).toBe(id(9));
  });

  test('exact retry with a fresh verified proof reuses original token, jti, iat, exp and key', async () => {
    const h = harness();
    const first = await h.issue(input());
    h.setSource({ databaseNowSeconds: now + 10 });
    const replay = await h.issue(input(id(11), now + 10));
    expect(replay).toEqual(first);
    expect(h.store.issuances).toHaveLength(1);
    expect(h.store.proofUses).toHaveLength(2);
    expect(h.transactions()).toBe(2);
    expect(h.allocations()).toBe(1);
  });

  test('changed raw request, target body or current source conflicts under the original operation', async () => {
    for (const changed of ['request', 'body', 'source'] as const) {
      const h = harness();
      await h.issue(input());
      h.setSource({ databaseNowSeconds: now + 10 });
      let retry = input(id(11), now + 10);
      if (changed === 'request') {
        const raw = Buffer.from(`${Buffer.from(retry.rawIssuanceRequestBytes).toString()} `);
        retry = {
          ...retry, rawIssuanceRequestBytes: raw,
          proof: { ...retry.proof, requestSha256: createHash('sha256').update(raw).digest('hex') },
        };
      } else if (changed === 'body') {
        retry = { ...retry, binding: { ...retry.binding,
          body: Buffer.from(`{ "schemaVersion":1,"generationJobId":"${id(1)}"}`) } };
      } else {
        h.setSource({ clientId: id(12) });
      }
      await expect(h.issue(retry)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(h.store.issuances).toHaveLength(1);
      expect(h.store.proofUses).toHaveLength(changed === 'request' ? 1 : 2);
      if (changed !== 'request') expect(h.store.proofUses[1]?.proofOutcome).toBe('denied');
      expect(h.allocations()).toBe(1);
    }
  });

  test('expired original claim or missing original key denies replay without a successor jti', async () => {
    for (const blocked of ['expired', 'key'] as const) {
      const h = harness();
      await h.issue(input());
      if (blocked === 'expired') h.setSource({ databaseNowSeconds: now + 60 });
      else {
        h.setSource({ databaseNowSeconds: now + 10 });
        h.setKeyAvailable(false);
      }
      const replayTime = blocked === 'expired' ? now + 60 : now + 10;
      await expect(h.issue(input(id(11), replayTime))).rejects.toMatchObject({
        code: blocked === 'expired' ? 'EXPIRED' : 'UNAVAILABLE',
      });
      expect(h.store.issuances).toHaveLength(1);
      expect(h.store.proofUses).toHaveLength(2);
      expect(h.store.proofUses[1]).toMatchObject({ operationDecision: 'issued', proofOutcome: 'denied' });
      expect(h.allocations()).toBe(1);
    }
  });

  test('a proof-use insert failure rolls back the issuance row in the same transaction', async () => {
    const h = harness();
    h.setFailProofInsert(true);
    await expect(h.issue(input())).rejects.toThrow('proof insert failed');
    expect(h.transactions()).toBe(1);
    expect(h.store.decisions).toHaveLength(0);
    expect(h.store.issuances).toHaveLength(0);
    expect(h.store.proofUses).toHaveLength(0);
  });

  test('a proof that expires while waiting for the operation lock cannot issue', async () => {
    const h = harness();
    let sourceReads = 0;
    h.setOnLoadCurrent(() => {
      sourceReads += 1;
      if (sourceReads === 2) h.setSource({ databaseNowSeconds: now + 30 });
    });
    await expect(h.issue(input())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(sourceReads).toBe(2);
    expect(h.locks()).toBe(1);
    expect(h.allocations()).toBe(0);
    expect(h.store.decisions).toMatchObject([{ decision: 'denied' }]);
    expect(h.store.issuances).toHaveLength(0);
    expect(h.store.proofUses).toMatchObject([{ proofOutcome: 'denied' }]);
  });

  test('a denied operation remains denied after source restoration and consumes fresh verified proofs', async () => {
    const h = harness(false);
    await expect(h.issue(input())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    h.setSource({ enabled: true, databaseNowSeconds: now + 10 });
    await expect(h.issue(input(id(11), now + 10))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.store.decisions).toHaveLength(1);
    expect(h.store.proofUses.map((proof) => proof.proofOutcome)).toEqual(['denied', 'denied']);
    expect(h.store.issuances).toHaveLength(0);
    expect(h.allocations()).toBe(0);
  });

  test('a proof denied after issuance cannot be redeemed if current source recovers', async () => {
    const h = harness();
    const issued = await h.issue(input());
    h.setSource({ enabled: false, databaseNowSeconds: now + 10 });
    await expect(h.issue(input(id(11), now + 10))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    h.setSource({ enabled: true, databaseNowSeconds: now + 11 });
    await expect(h.issue(input(id(11), now + 10))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await h.issue(input(id(12), now + 11))).toEqual(issued);
    expect(h.store.decisions).toMatchObject([{ decision: 'issued' }]);
    expect(h.store.proofUses.map((proof) => proof.proofOutcome)).toEqual(['issued', 'denied', 'issued']);
    expect(h.allocations()).toBe(1);
  });

  test('an already issued proof can only replay its original token after current source recovers', async () => {
    const h = harness();
    const original = await h.issue(input());
    h.setSource({ enabled: false, databaseNowSeconds: now + 10 });
    await expect(h.issue(input())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.store.proofUses).toMatchObject([{ proofOutcome: 'issued' }]);
    h.setSource({ enabled: true, databaseNowSeconds: now + 11 });
    expect(await h.issue(input())).toEqual(original);
    expect(h.store.proofUses).toHaveLength(1);
    expect(h.allocations()).toBe(1);
  });

  test('only semantic current-source absence commits a denial; unexpected port faults roll back', async () => {
    for (const fault of [new ObjectiveCurrentSourceUnavailable(),
      new ObjectiveWorkloadIssuanceError('UNAVAILABLE'), new Error('storage fault')]) {
      const h = harness();
      h.setOnLoadCurrent(() => { throw fault; });
      await expect(h.issue(input())).rejects.toThrow();
      expect(h.store.decisions).toHaveLength(fault instanceof ObjectiveCurrentSourceUnavailable ? 1 : 0);
      expect(h.store.proofUses).toHaveLength(fault instanceof ObjectiveCurrentSourceUnavailable ? 1 : 0);
      expect(h.store.issuances).toHaveLength(0);
    }
  });

  test('snapshots request, proof and binding before an awaited current-source read', async () => {
    const h = harness();
    const request = input();
    h.setOnLoadCurrent(() => {
      Object.assign(request.selector, { tenantId: id(12) });
      Object.assign(request.proof, { issuer: 'urn:capiro:changed:test:v1' });
      Object.assign(request.binding, { body: Buffer.from('{"changed":true}') });
    });
    const result = await h.issue(request);
    expect(h.store.issuances[0]).toMatchObject({
      tenantId: id(2), callerIssuer: 'urn:capiro:meri-worker:test:v1',
      targetBodySha256: createHash('sha256').update(binding.body).digest('hex'),
    });
    expect(verifyObjectiveWorkloadJwt(result.token, binding, {
      issuer, audience: OBJECTIVE_STRATEGY_AUDIENCE,
      publicKeys: { [signer.kid]: publicKey }, nowSeconds: now,
    }).tenantId).toBe(id(2));
  });

  test('refuses an empty raw issuer request before touching the ledger', async () => {
    const h = harness();
    const request = input();
    await expect(h.issue({ ...request, rawIssuanceRequestBytes: Buffer.alloc(0) }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.transactions()).toBe(0);
    expect(h.allocations()).toBe(0);
  });

  test('admission target body must be the closed job request before any source or ledger read', async () => {
    for (const body of [
      Buffer.from(`{"schemaVersion":1,"generationJobId":"${id(1)}","tenantId":"${id(2)}"}`),
      Buffer.from(`{"schemaVersion":2,"generationJobId":"${id(1)}"}`),
      Buffer.from(`{"schemaVersion":1,"generationJobId":"${id(12)}"}`),
      Buffer.from('{"schemaVersion":1}'),
      Buffer.from('{'),
    ]) {
      const h = harness();
      const request = input();
      await expect(h.issue({ ...request, binding: { ...request.binding, body } }))
        .rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(h.transactions()).toBe(0);
      expect(h.allocations()).toBe(0);
    }
  });
});
