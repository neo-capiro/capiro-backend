/**
 * WS22 / SCRUM-200 — the ACTUAL caller→receiver crossing proof for the native
 * failed-unit retry envelope.
 *
 * It is deliberately NOT a hand-written closed-key assertion on the producer
 * side (that is a different, weaker proof). This test takes the request the REAL
 * exported builder composes for a failed-unit ATTEMPT, lets the REAL
 * `NativeGenerationConversationClient` serialize it exactly as production does,
 * and feeds those exact bytes into the REAL accepted Meri leaf
 * (`apps/control/conversations/workspace-generation/application.mjs`) as its HTTP
 * request, with the leaf's own session/conversation seams faked in-process. No
 * network, no model, no provider, no database.
 *
 * The leaf checkout is read-only and is never copied: it is located through the
 * portable input configuration `WS22_MERI_LEAF_APPLICATION` (an absolute path or
 * file URL to the leaf's application.mjs). When it is not configured the file
 * reports a skip instead of a pass.
 *
 * Run (Node 24, native TypeScript transform + the scratch `.js`→`.ts` resolver):
 *   node --experimental-transform-types --test \
 *     --import <scratch>/ts-resolve.mjs test/workspace-generation-leaf-crossing.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const LEAF_APPLICATION = process.env.WS22_MERI_LEAF_APPLICATION ?? '';
const leafAvailable = LEAF_APPLICATION !== '' && existsSync(LEAF_APPLICATION);

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACTOR = 'user_synthetic_actor';
const DRAFT = 'draft_synthetic_1';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const SECRET = 'synthetic-internal-service-secret';
const IDENTITY = 'synthetic-identity-credential';
/** The ACTUAL native run the owner binds: a native UUID, never a Workspace id. */
const NATIVE_RUN = '44444444-4444-4444-4444-444444444444';
/** The Workspace durable run the retry attempt is a continuation of. */
const RETAINED_RUN = 'ws-run-retained-1';
const OTHER_NATIVE_RUN = '55555555-5555-5555-5555-555555555555';

const status = (state) => ({ type: 'run.status', sequence: 1, data: { state, reasonCode: null } });

/** The leaf's own in-process seams, mirroring its existing test fixture. */
function fixture({ runState = 'failed' } = {}) {
  const calls = { issue: [], allocate: [], submit: [], observe: [], history: [], cancel: [] };
  const issued = { conversationId: null, runId: NATIVE_RUN };
  const sessions = {
    async issue(input) {
      calls.issue.push(input);
      issued.conversationId = input.hints.conversationId;
      issued.runId = input.hints.runId ?? NATIVE_RUN;
      return {
        context: {
          tenantId: TENANT,
          actorId: ACTOR,
          conversationId: issued.conversationId,
          runId: issued.runId,
          selectedClientId: CLIENT,
        },
        credential: 'action_session_synthetic',
        expiresAtMs: Date.now() + 60_000,
      };
    },
  };
  const service = {
    async allocateInput(input) {
      calls.allocate.push(input);
      return {
        allocation: { binding: { conversationId: issued.conversationId, runId: issued.runId, tenantId: TENANT, actorId: ACTOR } },
      };
    },
    async submit(input) {
      calls.submit.push(input);
      return {
        run: {
          binding: { runId: issued.runId, tenantId: TENANT, actorId: ACTOR, conversationId: issued.conversationId },
          state: 'queued',
          scopes: [{ tenantId: TENANT, kind: 'client', resourceId: CLIENT, policyRevision: 'p1' }],
        },
        requestId: input.input.requestId,
        lastSequence: 1,
        replayed: false,
      };
    },
    async observe(input) {
      calls.observe.push(input);
      const run = {
        binding: { runId: issued.runId, tenantId: TENANT, actorId: ACTOR, conversationId: issued.conversationId },
        state: runState,
      };
      input.opened?.(run);
      input.deliver([status(runState)]);
    },
    async history(input) {
      calls.history.push(input);
      return {
        request: { requestId: input.requestIdForTest, requestSha256: 'b'.repeat(64) },
        run: {
          binding: { runId: issued.runId, tenantId: TENANT, actorId: ACTOR, conversationId: issued.conversationId },
          state: runState,
          scopes: [{ tenantId: TENANT, kind: 'client', resourceId: CLIENT, policyRevision: 'p1' }],
        },
        events: [status(runState)],
        lastSequence: 1,
        nextSequence: 1,
        hasMore: false,
      };
    },
    async cancel() {
      return { state: 'cancelled' };
    },
  };
  return { calls, sessions, service, issued };
}

test('the REAL client\u2019s retry ATTEMPT body is accepted by the REAL accepted Meri leaf', { skip: !leafAvailable && 'WS22_MERI_LEAF_APPLICATION is not configured' }, async () => {
  const leafRoot = pathToFileURL(LEAF_APPLICATION).href;
  const { createWorkspaceGenerationApplication } = await import(leafRoot);
  const { workspaceGenerationPaths } = await import(new URL('./protocol.mjs', leafRoot).href);
  const { conversationRequestIdFor } = await import(new URL('./phases.mjs', leafRoot).href);
  const { NativeGenerationConversationClient } = await import('../src/document-agent/native-generation-conversation.client.ts');
  const { nativeGenerationTurnRequest } = await import('../src/document-agent/native-generation.bridge.ts');

  // 1. The EXACT request the production builder composes for a failed-unit ATTEMPT:
  //    the original retained sources plus the server-owned attempt discriminator,
  //    which must refine the identity without ever travelling on the wire.
  const attempt = nativeGenerationTurnRequest({
    phase: 'document',
    tenantId: TENANT,
    actorId: ACTOR,
    draftId: DRAFT,
    clientId: CLIENT,
    expectedRevision: 7,
    sources: [
      { id: DRAFT, kind: 'workspace-draft' },
      { id: 's1', kind: 'workspace-section' },
    ],
    attemptRunId: RETAINED_RUN,
    attemptGeneration: 2,
  });
  const original = nativeGenerationTurnRequest({
    phase: 'document',
    tenantId: TENANT,
    actorId: ACTOR,
    draftId: DRAFT,
    clientId: CLIENT,
    expectedRevision: 7,
    sources: [
      { id: DRAFT, kind: 'workspace-draft' },
      { id: 's1', kind: 'workspace-section' },
    ],
  });
  assert.match(attempt.requestId, /^wsgen:[a-f0-9]{64}$/u, 'the derived identity is the leaf\u2019s own request-id vocabulary');
  assert.notEqual(attempt.requestId, original.requestId, 'the attempt is a genuinely distinct retained request');
  assert.equal(Object.hasOwn(attempt, 'attemptRunId'), false, 'the discriminator is a hash preimage only');
  assert.equal(Object.hasOwn(attempt, 'attemptGeneration'), false, 'the attempt generation is a hash preimage only');

  const fakes = fixture();
  fakes.service.history = async (input) => {
    fakes.calls.history.push(input);
    const { conversationRequestIdFor: derive } = await import(new URL('./phases.mjs', leafRoot).href);
    return {
      request: { requestId: derive(attempt.requestId), requestSha256: 'b'.repeat(64) },
      run: {
        binding: { runId: fakes.issued.runId ?? NATIVE_RUN, tenantId: TENANT, actorId: ACTOR, conversationId: fakes.issued.conversationId },
        state: 'failed',
        scopes: [{ tenantId: TENANT, kind: 'client', resourceId: CLIENT, policyRevision: 'p1' }],
      },
      events: [status('failed')],
      lastSequence: 1,
      nextSequence: 1,
      hasMore: false,
    };
  };
  const application = createWorkspaceGenerationApplication({
    sessions: fakes.sessions,
    service: fakes.service,
    getServiceSecret: async () => SECRET,
    now: Date.now,
  });

  const sent = [];
  const client = new NativeGenerationConversationClient({
    origin: 'https://control.internal.example',
    serviceSecret: SECRET,
    fetchImpl: async (url, init) => {
      sent.push({ url: String(url), body: init.body, headers: init.headers });
      return application.handle(new Request(String(url), init));
    },
  });

  // 2. The turn: the production client's OWN serialization of that attempt, into
  //    the accepted leaf's OWN turn reader. A closed-key mismatch is a 400 here.
  const turnOutcome = await client.turn(attempt, { credential: IDENTITY });
  assert.equal(turnOutcome.status, 'failed', 'the leaf accepted the retry turn and answered its real outcome');
  assert.equal(turnOutcome.runId, NATIVE_RUN);
  assert.equal(sent[0].url, 'https://control.internal.example/v1/internal/workspace-generation/turn');
  const posted = JSON.parse(sent[0].body);
  assert.equal(posted.schemaVersion, 1);
  assert.deepEqual(
    Object.keys(posted.request).sort(),
    ['actorId', 'clientId', 'draftId', 'expectedRevision', 'paidGeneration', 'phase', 'requestId', 'sources', 'tenantId'].sort(),
    'the body the REAL client posted carries exactly the leaf\u2019s closed TURN_KEYS',
  );
  assert.equal(sent[0].body.includes(RETAINED_RUN), false, 'the retained Workspace run never travels on the wire');
  assert.equal(sent[0].body.includes('attemptGeneration'), false, 'the attempt generation never travels on the wire');
  // The conversation turn the leaf submitted is derived from the exact attempt.
  assert.equal(fakes.calls.submit.length, 1);
  assert.equal(fakes.calls.submit[0].input.requestId, conversationRequestIdFor(attempt.requestId));
  assert.notEqual(conversationRequestIdFor(attempt.requestId), conversationRequestIdFor(original.requestId));

  // 3. The DEFECT this fix closes, proven against the receiver itself: the exact
  //    shape the previous candidate posted (the discriminator on the turn request
  //    as `runId`) is refused by the accepted leaf, not silently accepted.
  const defectBody = JSON.stringify({ schemaVersion: 1, request: { ...posted.request, runId: RETAINED_RUN } });
  const refused = await application.handle(
    new Request('https://control.internal.example/v1/internal/workspace-generation/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${IDENTITY}`, 'x-internal-service-secret': SECRET },
      body: defectBody,
    }),
  );
  assert.equal(refused.status, 400, 'the receiver closes its turn shape; a leaked discriminator is a real 400');
  assert.equal((await refused.json()).error.code, 'WORKSPACE_GENERATION_REFUSED');
  assert.equal(fakes.calls.submit.length, 1, 'the refused body dispatched nothing');

  // 4. The read: the SAME retained request, with the genuine NATIVE run binding.
  const readOutcome = await client.readTurn({ ...attempt, runId: NATIVE_RUN }, IDENTITY);
  assert.equal(readOutcome.status, 'failed', 'the same retained attempt reconciles through the same owner');
  assert.equal(readOutcome.runId, NATIVE_RUN);
  assert.equal(sent[1].url, 'https://control.internal.example/v1/internal/workspace-generation/read');
  const readPosted = JSON.parse(sent[1].body).request;
  assert.equal(readPosted.runId, NATIVE_RUN, 'the read binds the owner\u2019s OWN native run');
  assert.equal(readPosted.requestId, attempt.requestId);
  assert.equal(fakes.calls.history.length >= 1, true);

  // A repeated attempt (duplicate click / reload) presents the SAME derived
  // conversation request, so the owner answers from its retained journal.
  await client.turn(attempt, { credential: IDENTITY });
  assert.equal(fakes.calls.submit.length, 2);
  assert.equal(fakes.calls.submit[1].input.requestId, fakes.calls.submit[0].input.requestId);

  // A read that claims a DIFFERENT native run than the authority resolved is a
  // scope refusal, never a rebinding of the retained request.
  fakes.sessions.issue = async (input) => {
    const conversationId = input.hints.conversationId;
    return {
      context: {
        tenantId: TENANT,
        actorId: ACTOR,
        conversationId,
        runId: OTHER_NATIVE_RUN,
        selectedClientId: CLIENT,
      },
      credential: 'action_session_synthetic',
      expiresAtMs: Date.now() + 60_000,
    };
  };
  await assert.rejects(
    () => client.readTurn({ ...attempt, runId: NATIVE_RUN }, IDENTITY),
    (error) => error.status === 403,
  );
});
